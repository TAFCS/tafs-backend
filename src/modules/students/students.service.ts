import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { GetStudentsDto } from './dto/get-students.dto';
import { calculateOffset } from '../../utils/pagination.util';
import { createPaginationMeta } from '../../utils/serializer.util';
import { Prisma } from '@prisma/client';

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) { }

  async findAll(query: GetStudentsDto) {
    const { page = 1, limit = 10, search, campus_id, status, fields } = query;
    const offset = calculateOffset(page, limit);

    // Build modern dynamic where clause
    const where: Prisma.studentsWhereInput = {
      deleted_at: null,
    };

    if (search) {
      where.OR = [
        { first_name: { contains: search, mode: 'insensitive' } },
        { last_name: { contains: search, mode: 'insensitive' } },
        { gr_number: { contains: search, mode: 'insensitive' } },
        { cc_number: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (campus_id) {
      where.campus_id = campus_id;
    }

    if (status) {
      where.status = status;
    }

    // Determine what relations to include based on user's selected fields
    // If fields is undefined, we return ALL categories by default.
    const requestedFields = fields && fields.length > 0
      ? new Set(fields)
      : new Set(['core', 'academic', 'family', 'contact', 'demographic', 'medical', 'history']);

    // Build the dynamic 'select' object
    const selectArgs: Prisma.studentsSelect = {
      // Base keys required for internal operations
      id: true,
    };

    if (requestedFields.has('core')) {
      selectArgs.first_name = true;
      selectArgs.last_name = true;
      selectArgs.cc_number = true;
      selectArgs.gr_number = true;
      selectArgs.status = true;
      selectArgs.photograph_url = true;
      selectArgs.campuses = { select: { campus_name: true, campus_code: true } };
    }

    if (requestedFields.has('academic')) {
      selectArgs.admission_age_years = true;
      selectArgs.student_admissions = {
        orderBy: { application_date: 'desc' },
        take: 1,
        select: {
          requested_grade: true,
          academic_system: true,
          academic_year: true,
          application_date: true,
        },
      };
    }

    if (requestedFields.has('family')) {
      selectArgs.family_id = true;
      selectArgs.families = {
        select: {
          legacy_pid: true,
          household_name: true,
          primary_address: true,
          students: {
            where: { deleted_at: null },
            select: {
              id: true,
              first_name: true,
              last_name: true,
              cc_number: true,
              student_guardians: {
                where: { is_primary_contact: true },
                take: 1,
                select: {
                  guardians: { select: { full_name: true } }
                }
              }
            }
          },
          _count: { select: { students: true } } // For sibling_count
        },
      };
    }

    if (requestedFields.has('contact')) {
      selectArgs.primary_phone = true;
      selectArgs.whatsapp_number = true;
      selectArgs.student_guardians = {
        where: { is_primary_contact: true },
        take: 1,
        select: {
          relationship: true,
          guardians: {
            select: {
              full_name: true,
              cnic: true,
              whatsapp_number: true,
              primary_phone: true,
              occupation: true,
            },
          },
        },
      };
    }

    if (requestedFields.has('demographic')) {
      selectArgs.dob = true;
      selectArgs.gender = true;
      selectArgs.nationality = true;
      selectArgs.religion = true;
      selectArgs.place_of_birth = true;
      selectArgs.email = true;
    }

    if (requestedFields.has('medical')) {
      selectArgs.medical_info = true;
      selectArgs.physical_impairment = true;
      selectArgs.identification_marks = true;
      // Emergency info joins through guardians
      if (!selectArgs.student_guardians) {
        selectArgs.student_guardians = {};
      }
      selectArgs.student_guardians = {
        ...(typeof selectArgs.student_guardians === 'object' ? selectArgs.student_guardians : {}),
        where: { OR: [{ is_primary_contact: true }, { is_emergency_contact: true }] },
        select: {
          is_primary_contact: true,
          is_emergency_contact: true,
          relationship: true,
          guardians: {
            select: {
              full_name: true,
              cnic: true,
              whatsapp_number: true,
              primary_phone: true,
              occupation: true,
            },
          },
        },
      };
    }

    if (requestedFields.has('history')) {
      selectArgs.student_previous_schools = {
        take: 1,
        orderBy: { id: 'desc' },
        select: {
          school_name: true,
          reason_for_leaving: true,
        },
      };
      selectArgs.student_activities = {
        select: {
          activity_name: true,
          honors_awards: true,
        },
      };
    }

    // Execute count and data queries concurrently
    const [total, studentsData] = await Promise.all([
      this.prisma.students.count({ where }),
      this.prisma.students.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { created_at: 'desc' },
        select: Object.keys(selectArgs).length > 1 ? selectArgs : { id: true }, // Ensure at least id is selected
      }),
    ]);

    // Map and flatten response structure
    const mappedItems = studentsData.map((s: any) => {
      let primaryGuardianNode: any = null;
      let emergencyGuardianNode: any = null;

      if (s.student_guardians) {
        primaryGuardianNode = s.student_guardians.find((g: any) => g.is_primary_contact !== false);
        emergencyGuardianNode = s.student_guardians.find((g: any) => g.is_emergency_contact === true);
        // fallback for when only one record exists but explicit booleans aren't returned safely
        if (!primaryGuardianNode && s.student_guardians.length > 0) primaryGuardianNode = s.student_guardians[0];
      }

      const primaryGuardian = primaryGuardianNode?.guardians;
      const emergencyGuardian = emergencyGuardianNode?.guardians;
      const latestAdmission = s.student_admissions?.[0] || null;
      const previousSchool = s.student_previous_schools?.[0] || null;

      const mappedData: any = { id: s.id };

      if (requestedFields.has('core')) {
        mappedData.core = {
          id: s.id,
          first_name: s.first_name,
          last_name: s.last_name,
          full_name: `${s.first_name} ${s.last_name}`.trim(),
          cc_number: s.cc_number,
          gr_number: s.gr_number,
          campus_name: s.campuses?.campus_name,
          campus_code: s.campuses?.campus_code,
          enrollment_status: s.status,
          photograph_url: s.photograph_url,
        };
      }

      if (requestedFields.has('academic')) {
        mappedData.academic = {
          academic_system: latestAdmission?.academic_system,
          requested_grade: latestAdmission?.requested_grade,
          academic_year: latestAdmission?.academic_year,
          application_date: latestAdmission?.application_date,
          admission_age_years: s.admission_age_years,
        };
      }

      if (requestedFields.has('family')) {
        mappedData.family = {
          family_id: s.family_id,
          legacy_pid: s.families?.legacy_pid,
          household_name: s.families?.household_name,
          primary_address: s.families?.primary_address,
          sibling_count: s.families?._count?.students,
          siblings: s.families?.students
            ?.filter((sib: any) => sib.id !== s.id)
            ?.map((sib: any) => ({
              id: sib.id,
              full_name: `${sib.first_name} ${sib.last_name}`.trim(),
              cc_number: sib.cc_number,
              father_name: sib.student_guardians?.[0]?.guardians?.full_name,
            })),
        };
      }

      if (requestedFields.has('contact')) {
        mappedData.contact = {
          primary_guardian_name: primaryGuardian?.full_name,
          guardian_relationship: primaryGuardianNode?.relationship,
          whatsapp_number: primaryGuardian?.whatsapp_number || s.whatsapp_number,
          primary_phone: primaryGuardian?.primary_phone || s.primary_phone,
          guardian_cnic: primaryGuardian?.cnic,
          guardian_occupation: primaryGuardian?.occupation,
        };
      }

      if (requestedFields.has('demographic')) {
        mappedData.demographic = {
          dob: s.dob,
          gender: s.gender,
          nationality: s.nationality,
          religion: s.religion,
          place_of_birth: s.place_of_birth,
          email: s.email,
        };
      }

      if (requestedFields.has('medical')) {
        mappedData.medical = {
          medical_info: s.medical_info,
          physical_impairment: s.physical_impairment,
          identification_marks: s.identification_marks,
          emergency_contact_info: emergencyGuardian ? {
            name: emergencyGuardian.full_name,
            phone: emergencyGuardian.primary_phone || emergencyGuardian.whatsapp_number,
          } : null,
        };
      }

      if (requestedFields.has('history')) {
        mappedData.history = {
          previous_school_name: previousSchool?.school_name,
          reason_for_leaving: previousSchool?.reason_for_leaving,
          student_activities: s.student_activities || [],
        };
      }

      // Add a flattened "legacy" root map for the frontend's existing datatable usage
      // This bridges the gap between the new nested structure and what the frontend expects.
      return {
        ...mappedData,
        // Frontend compatibility flattened fields:
        student_full_name: mappedData.core?.full_name,
        gr_number: mappedData.core?.gr_number,
        cc_number: mappedData.core?.cc_number,
        campus: mappedData.core?.campus_name,
        grade_and_section: mappedData.academic?.requested_grade,
        primary_guardian_name: mappedData.contact?.primary_guardian_name,
        whatsapp_number: mappedData.contact?.whatsapp_number,
        enrollment_status: mappedData.core?.enrollment_status,
        financial_status_badge: 'CLEARED',
        family_id: mappedData.family?.family_id,
        household_name: mappedData.family?.household_name,
        primary_guardian_cnic: mappedData.contact?.guardian_cnic,
        date_of_birth: mappedData.demographic?.dob,
        registration_number: mappedData.core?.cc_number,
        residential_address: mappedData.family?.primary_address,
        siblings: mappedData.family?.siblings,
      };
    });

    const meta = createPaginationMeta(page, limit, total);

    return { items: mappedItems, meta };
  }

  async findOne(id: number) {
    const s = await this.prisma.students.findFirst({
      where: { id, deleted_at: null },
      include: {
        campuses: true,
        families: {
          include: {
            students: {
              where: { deleted_at: null },
              select: {
                id: true,
                first_name: true,
                last_name: true,
                cc_number: true,
                student_guardians: {
                  where: { is_primary_contact: true },
                  take: 1,
                  select: { guardians: { select: { full_name: true } } }
                }
              }
            },
            _count: { select: { students: true } }
          }
        },
        student_admissions: { orderBy: { application_date: 'desc' }, take: 1 },
        student_guardians: {
          where: { OR: [{ is_primary_contact: true }, { is_emergency_contact: true }] },
          include: { guardians: true }
        },
        student_previous_schools: { orderBy: { id: 'desc' }, take: 1 },
        student_activities: true,
      }
    });

    if (!s) throw new NotFoundException(`Student #${id} not found`);

    const primaryGuardianNode = s.student_guardians.find((g: any) => g.is_primary_contact !== false) || s.student_guardians[0];
    const primaryGuardian = primaryGuardianNode?.guardians;

    return {
      id: s.id,
      student_full_name: `${s.first_name} ${s.last_name}`.trim(),
      gr_number: s.gr_number,
      cc_number: s.cc_number,
      campus: s.campuses?.campus_name,
      campus_code: s.campuses?.campus_code,
      grade_and_section: s.student_admissions?.[0]?.requested_grade,
      enrollment_status: s.status,
      financial_status_badge: 'CLEARED',
      family_id: s.family_id,
      household_name: s.families?.household_name,
      primary_guardian_name: primaryGuardian?.full_name,
      primary_guardian_cnic: primaryGuardian?.cnic,
      whatsapp_number: primaryGuardian?.whatsapp_number || s.whatsapp_number,
      primary_phone: primaryGuardian?.primary_phone || s.primary_phone,
      date_of_birth: s.dob,
      registration_number: s.cc_number,
      residential_address: s.families?.primary_address,
      siblings: s.families?.students
        ?.filter((sib: any) => sib.id !== s.id)
        ?.map((sib: any) => ({
          id: sib.id,
          full_name: `${sib.first_name} ${sib.last_name}`.trim(),
          cc_number: sib.cc_number,
          father_name: sib.student_guardians?.[0]?.guardians?.full_name,
        })),
    };
  }
}