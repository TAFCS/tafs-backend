import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { GetStudentsDto } from './dto/get-students.dto';
import { calculateOffset } from '../../utils/pagination.util';
import { createPaginationMeta } from '../../utils/serializer.util';
import { Prisma } from '@prisma/client';
import { ClassSelectorDto } from './dto/class-selector.dto';
import { PromoteSingleStudentDto } from './dto/promote-single-student.dto';
import { PromoteBulkStudentsDto } from './dto/promote-bulk-students.dto';
import { StudentStatus } from '../../constants/student-status.constant';

type PromotionStatus = 'promoted' | 'graduated' | 'expelled' | 'skipped' | 'failed';

type PromotionReasonCode =
  | 'STUDENT_NOT_FOUND'
  | 'FROM_CLASS_MISMATCH'
  | 'ALREADY_AT_TARGET'
  | 'ALREADY_GRADUATED'
  | 'ALREADY_EXPELLED'
  | 'TARGET_CLASS_INACTIVE_FOR_CAMPUS'
  | 'TARGET_SECTION_INVALID_FOR_CLASS_CAMPUS'
  | 'MISSING_TARGET'
  | 'INTERNAL_ERROR';

type PromotionOutcome = {
  student_id: number;
  status: PromotionStatus;
  reason_code?: PromotionReasonCode;
  message: string;
  from_class_id?: number | null;
  to_class_id?: number | null;
  from_academic_year?: string | null;
  to_academic_year?: string;
  graduated?: boolean;
  expelled?: boolean;
  dry_run: boolean;
};

type ResolvedClass = {
  id: number;
  description: string;
  class_code: string;
  academic_system: string;
};

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) { }

  private readonly assignmentInclude = {
    campuses: { select: { campus_name: true, campus_code: true } },
    classes: { select: { description: true, class_code: true } },
    sections: { select: { description: true } },
    houses: { select: { house_name: true } },
  } as const;

  private async getFinancialDigest(studentId: number) {
    const [fees, deposits, allocations] = await Promise.all([
      this.prisma.student_fees.findMany({
        where: { student_id: studentId },
        select: { amount: true, amount_paid: true, due_date: true, status: true }
      }),
      this.prisma.deposits.findMany({
        where: { student_id: studentId },
        select: { total_amount: true }
      }),
      this.prisma.deposit_allocations.findMany({
        where: { deposits: { student_id: studentId } },
        select: { amount: true }
      })
    ]);

    const totalDeposits = deposits.reduce((sum, d) => sum.add(d.total_amount || 0), new Prisma.Decimal(0));
    const totalAllocations = allocations.reduce((sum, a) => sum.add(a.amount || 0), new Prisma.Decimal(0));
    const advance = totalDeposits.sub(totalAllocations);

    if (fees.length === 0) {
      return {
        badge: 'NO_SCHEDULE',
        outstanding: 0,
        advance: advance.toNumber()
      };
    }

    let outstanding = new Prisma.Decimal(0);
    let anyOverdue = false;
    let anyPartial = false;
    const now = new Date();

    for (const fee of fees) {
      const balance = new Prisma.Decimal(fee.amount || 0).sub(fee.amount_paid || 0);
      if (balance.gt(0)) {
        outstanding = outstanding.add(balance);
        if (fee.due_date && fee.due_date < now) {
          anyOverdue = true;
        }
        if (new Prisma.Decimal(fee.amount_paid || 0).gt(0)) {
          anyPartial = true;
        }
      }
    }

    let badge = 'Cleared';
    if (anyOverdue) badge = 'Overdue';
    else if (outstanding.gt(0)) badge = anyPartial ? 'Partial' : 'Partial'; // default to Partial if any unpaid

    // If outstanding > 0 but not overdue or partial, it's just 'Partial' (or we could add 'Pending')
    // Existing frontend only handles Cleared, Overdue, Partial.
    // I'll map anything with balance to 'Partial' for now to fit existing styles, or just use the logic below.
    if (anyOverdue) badge = 'Overdue';
    else if (outstanding.gt(0)) {
        badge = anyPartial ? 'Partial' : 'Partial';
    } else {
        badge = 'Cleared';
    }

    return {
      badge,
      outstanding: outstanding.toNumber(),
      advance: advance.toNumber()
    };
  }

  async findAll(query: GetStudentsDto) {
    const { page = 1, limit = 10, search, campus_id, class_id, section_id, house_id, status, fields } = query;
    const offset = calculateOffset(page, limit);

    const where: Prisma.studentsWhereInput = { deleted_at: null };

    if (search) {
      const isNumeric = /^\d+$/.test(search);
      const isShortNumeric = isNumeric && search.length <= 5;

      where.OR = [
        { full_name: { contains: search, mode: 'insensitive' } },
        { gr_number: { contains: search, mode: 'insensitive' } },
        ...(isNumeric ? [{ cc: Number(search) }] : []),
        // Only search CNIC if it's not a short numeric string (likely intended for CC/GR)
        ...(!isShortNumeric ? [{
          student_guardians: {
            some: {
              guardians: {
                cnic: { contains: search, mode: Prisma.QueryMode.insensitive }
              }
            }
          }
        }] : []),
      ];
    }
    if (campus_id)   where.campus_id  = campus_id;
    if (class_id)    where.class_id   = class_id;
    if (section_id)  where.section_id = section_id;
    if (house_id)    where.house_id   = house_id;
    if (status)      where.status     = status;

    // TEMP: Data Audit Filter (using raw SQL fallback for compatibility)
    if (query.is_abnormal === '1' || query.is_abnormal === 'true' || (query as any).is_abnormal === true) {
      const abnormalStudents: any[] = await this.prisma.$queryRaw`
        SELECT cc FROM students s
        WHERE
          NOT EXISTS (SELECT 1 FROM student_guardians sg WHERE sg.student_id = s.cc)
          OR
          cc IN (
            SELECT student_id FROM student_guardians
            GROUP BY student_id
            HAVING COUNT(*) > 2
          )
      `;
      const abnormalCcs = abnormalStudents.map(s => s.cc);
      where.cc = { in: abnormalCcs };
    }

    // Determine what relations to include based on user's selected fields
    // If fields is undefined, we return ALL categories by default.
    const requestedFields = fields && fields.length > 0
      ? new Set(fields)
      : new Set(['core', 'academic', 'family', 'contact', 'demographic', 'medical', 'history']);

    // Build the dynamic 'select' object
    const selectArgs: Prisma.studentsSelect = {
      // Base keys required for internal operations
      cc: true,
    };

    if (requestedFields.has('core')) {
      selectArgs.full_name = true;
      selectArgs.gr_number = true;
      selectArgs.class_id  = true;
      selectArgs.section_id = true;
      selectArgs.house_id  = true;
      selectArgs.status = true;
      selectArgs.photograph_url = true;
      selectArgs.campuses  = { select: { campus_name: true, campus_code: true } };
      selectArgs.classes   = { select: { description: true, class_code: true } };
      selectArgs.sections  = { select: { description: true } };
      selectArgs.houses    = { select: { house_name: true, house_color: true } };
      selectArgs.family_id = true;
      selectArgs.families  = {
        include: {
          students: {
            where: { deleted_at: null },
            include: { student_guardians: { include: { guardians: true }, take: 1 } }
          }
        }
      };
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
              cc: true,
              full_name: true,
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
        orderBy: { cc: 'desc' },
        select: Object.keys(selectArgs).length > 1 ? selectArgs : { cc: true }, // Ensure at least cc is selected
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

      // Inheritance fallback for list view if core guardian is missing
      if (!primaryGuardianNode && s.family_id && s.families?.students) {
        const siblingWithGuardian = s.families.students.find((sib: any) => sib.cc !== s.cc && sib.student_guardians?.length > 0);
        if (siblingWithGuardian) {
          primaryGuardianNode = siblingWithGuardian.student_guardians[0];
        }
      }

      const primaryGuardian = primaryGuardianNode?.guardians;
      const emergencyGuardian = emergencyGuardianNode?.guardians;
      const latestAdmission = s.student_admissions?.[0] || null;
      const previousSchool = s.student_previous_schools?.[0] || null;

      const mappedData: any = { cc: s.cc };

      if (requestedFields.has('core')) {
        mappedData.core = {
          cc: s.cc,
          full_name: s.full_name,
          cc_number: s.cc,
          gr_number: s.gr_number,
          campus_name: s.campuses?.campus_name,
          campus_code: s.campuses?.campus_code,
          class_description: s.classes?.description,
          class_code: s.classes?.class_code,
          section_description: s.sections?.description,
          house_name: s.houses?.house_name,
          house_color: s.houses?.house_color,
          enrollment_status: s.status,
          photograph_url: s.photograph_url,
          primary_guardian_name: primaryGuardianNode?.guardians?.full_name,
          guardian_relationship: primaryGuardianNode?.relationship,
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
            ?.filter((sib: any) => sib.cc !== s.cc)
            ?.map((sib: any) => ({
              cc: sib.cc,
              full_name: sib.full_name,
              cc_number: sib.cc,
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
        class_id: s.class_id,
        grade_and_section: mappedData.academic?.requested_grade,
        primary_guardian_name: mappedData.contact?.primary_guardian_name,
        whatsapp_number: mappedData.contact?.whatsapp_number,
        enrollment_status: mappedData.core?.enrollment_status,
        financial_status_badge: null, // List view shouldn't guess; modal will fetch actual status
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
      where: { cc: id, deleted_at: null },
      include: {
        campuses: true,
        families: {
          include: {
            students: {
              where: { deleted_at: null },
              select: {
                cc: true,
                full_name: true,
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
          include: { guardians: true }
        },
         student_previous_schools: { orderBy: { id: 'desc' }, take: 1 },
        student_activities: true,
        student_flags: { where: { work_done: false } },
      }
    });

    if (!s) throw new NotFoundException(`Student #${id} not found`);

    // Inheritance fallback for guardians
    if (s.student_guardians.length === 0 && s.family_id) {
       const inherited = await this.prisma.student_guardians.findMany({
         where: { students: { family_id: s.family_id } },
         include: { guardians: true },
         orderBy: { guardian_id: 'asc' }
       });
       const seen = new Set();
       s.student_guardians = inherited.filter(link => {
         if (seen.has(link.guardian_id)) return false;
         seen.add(link.guardian_id);
         return true;
       });
    }

    const primaryGuardianNode = s.student_guardians.find((g: any) => g.is_primary_contact === true) || s.student_guardians[0];
    const primaryGuardian = primaryGuardianNode?.guardians;
    const fatherNode = s.student_guardians.find((g: any) => g.relationship === 'FATHER') || primaryGuardianNode;

    const financial = await this.getFinancialDigest(s.cc);

    let resolvedClassId = s.class_id;
    if (!resolvedClassId && s.status === 'SOFT_ADMISSION') {
      const requestedGrade = s.student_admissions?.[0]?.requested_grade;
      if (requestedGrade) {
        const normalized = requestedGrade.replace(/[-\s]/g, '').toUpperCase();
        const matchedClass = await this.prisma.classes.findFirst({
          where: {
            OR: [
              { class_code: requestedGrade },
              { class_code: normalized },
              { description: requestedGrade },
            ],
          },
          select: { id: true }
        });
        resolvedClassId = matchedClass?.id ?? null;
      }
    }

    return {
      cc: s.cc,
      student_full_name: s.full_name,
      gr_number: s.gr_number,
      cc_number: s.cc,
      campus: s.campuses?.campus_name,
      campus_code: s.campuses?.campus_code,
      campus_id: s.campus_id,
      class_id: resolvedClassId,
      section_id: s.section_id,
      grade_and_section: s.student_admissions?.[0]?.requested_grade,
      enrollment_status: s.status,
      financial_status_badge: financial.badge,
      total_outstanding_balance: financial.outstanding,
      advance_credit_balance: financial.advance,
      family_id: s.family_id,
      household_name: s.families?.household_name,
      primary_guardian_name: primaryGuardian?.full_name,
      primary_guardian_cnic: primaryGuardian?.cnic,
      whatsapp_number: primaryGuardian?.whatsapp_number || s.whatsapp_number,
      primary_phone: primaryGuardian?.primary_phone || s.primary_phone,
      home_phone: s.families?.home_phone || s.home_phone,
      date_of_birth: s.dob,
      gender: s.gender,
      registration_number: s.cc,
      father_name: fatherNode?.guardians?.full_name || primaryGuardian?.full_name,
      residential_address: s.families?.primary_address || (() => {
        const g = primaryGuardian;
        if (!g) return null;
        return [
          g.house_appt_number,
          g.house_appt_name,
          g.area_block,
          g.city,
          g.province,
          g.country
        ].filter(Boolean).join(', ') || null;
      })(),
      photograph_url: s.photograph_url,
      photo_blue_bg_url: s.photo_blue_bg_url,
      date_of_admission: s.doa,
      families: s.families ? {
        household_name: s.families.household_name,
        legacy_pid: s.families.legacy_pid,
        home_phone: s.families.home_phone,
      } : null,
      siblings: s.families?.students
        ?.filter((sib: any) => sib.cc !== s.cc)
        ?.map((sib: any) => ({
          cc: sib.cc,
          full_name: sib.full_name,
          cc_number: sib.cc,
          father_name: sib.student_guardians?.[0]?.guardians?.full_name,
        })),
    };
  }

  async assignStudent(id: number, dto: any) {
    const student = await this.prisma.students.findUnique({
        where: { cc: id },
    });

    if (!student || student.deleted_at) {
        throw new NotFoundException(`Student #${id} not found`);
    }

    return this.prisma.students.update({
        where: { cc: id },
        data: {
            campus_id: dto.campus_id !== undefined ? dto.campus_id : undefined,
            class_id: dto.class_id !== undefined ? dto.class_id : undefined,
            section_id: dto.section_id !== undefined ? dto.section_id : undefined,
            house_id: dto.house_id !== undefined ? dto.house_id : undefined,
        },
        include: this.assignmentInclude,
    });
  }

  async unexpelStudent(id: number) {
    const student = await this.prisma.students.findUnique({
      where: { cc: id },
      select: {
        cc: true,
        status: true,
        deleted_at: true,
      },
    });

    if (!student || student.deleted_at) {
      throw new NotFoundException(`Student #${id} not found`);
    }

    if (student.status !== StudentStatus.EXPELLED) {
      throw new BadRequestException('Only expelled students can be unexpelled');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.students.update({
        where: { cc: id },
        data: {
          status: StudentStatus.ENROLLED,
        },
        include: this.assignmentInclude,
      });

      await tx.student_flags.updateMany({
        where: {
          student_id: id,
          flag: 'EXPELLED',
          work_done: false,
        },
        data: {
          work_done: true,
        },
      });

      await tx.student_flags.create({
        data: {
          student_id: id,
          flag: `UNEXPELLED_LOG_${Date.now()}`,
          reminder_date: new Date(),
          work_done: true,
          comment: 'Student status restored to ENROLLED',
        },
      });

      return updated;
    });
  }

  async promoteSingle(dto: PromoteSingleStudentDto) {
    const result = await this.promoteBulk({
      from: dto.from,
      to: dto.to,
      graduate: dto.graduate,
      expel: dto.expel,
      target_academic_year: dto.target_academic_year,
      to_section_id: dto.to_section_id,
      student_ids: [dto.student_id],
      reason: dto.reason,
      dry_run: dto.dry_run,
    });

    return {
      ...result,
      outcome: result.results[0] || null,
    };
  }

  async promoteBulk(dto: PromoteBulkStudentsDto) {
    // Validate: exactly one of `to`, `graduate`, or `expel` must be set
    const isGraduating = !!dto.graduate;
    const isExpelling = !!dto.expel;

    if (!isGraduating && !isExpelling && !dto.to) {
      throw new BadRequestException('Either `to` (target class), `graduate: true`, or `expel: true` must be provided');
    }
    const actionCount = [!!dto.to, isGraduating, isExpelling].filter(Boolean).length;
    if (actionCount > 1) {
      throw new BadRequestException('Only one of `to`, `graduate`, or `expel` may be specified at a time');
    }

    const fromClass = await this.resolveClassSelector(dto.from, 'from');
    const toClass = isGraduating || isExpelling ? null : await this.resolveClassSelector(dto.to!, 'to');

    if (!isGraduating && !isExpelling && toClass && fromClass.id === toClass.id) {
      throw new BadRequestException('From and to class must be different for promotion');
    }

    const dryRun = !!dto.dry_run;
    const distinctStudentIds = dto.student_ids?.length
      ? Array.from(new Set(dto.student_ids))
      : undefined;
    const isExplicitIds = !!(distinctStudentIds && distinctStudentIds.length > 0);

    // Campus, section and source academic_year filters only apply in batch (class-wide) mode.
    // When explicit student_ids are provided, we look up exactly those students by cc —
    // no extra filters, because the user explicitly asked for those IDs. Mismatches
    // (wrong class, wrong campus) are handled gracefully in processPromotionForStudent.
    const where: Prisma.studentsWhereInput = { deleted_at: null };

    if (!isExplicitIds) {
      if (dto.campus_id !== undefined) {
        where.campus_id = dto.campus_id;
      }

      if (dto.section_id !== undefined) {
        where.section_id = dto.section_id;
      }

      // Filter candidates by their current academic year.
      // This is a SOURCE filter — it narrows which students are picked up for promotion.
      // A class can have students from different years (e.g. held-back students from a
      // prior year). Use this to target only those currently in a specific year.
      if (dto.academic_year !== undefined) {
        where.academic_year = dto.academic_year;
      }
    }

    if (isExplicitIds) {
      where.cc = { in: distinctStudentIds };
    } else {
      where.class_id = fromClass.id;
    }

    const candidates = await this.prisma.students.findMany({
      where,
      select: {
        cc: true,
        class_id: true,
        section_id: true,
        campus_id: true,
        academic_year: true,
        status: true,
      },
      orderBy: { cc: 'asc' },
    });

    const classActiveCache = new Map<string, boolean>();
    const sectionActiveCache = new Map<string, boolean>();
    const results: PromotionOutcome[] = [];

    if (isExplicitIds) {
      const byId = new Map(candidates.map((s) => [s.cc, s]));
      for (const studentId of distinctStudentIds!) {
        const student = byId.get(studentId);
        if (!student) {
          results.push({
            student_id: studentId,
            status: 'failed',
            reason_code: 'STUDENT_NOT_FOUND',
            message: 'Student not found or does not match provided filters',
            dry_run: dryRun,
          });
          continue;
        }

        const outcome = await this.processPromotionForStudent(
          student,
          fromClass,
          toClass,
          isGraduating,
          isExpelling,
          isExplicitIds,
          dto.to_section_id,
          dto.reason,
          dto.target_academic_year,
          dryRun,
          classActiveCache,
          sectionActiveCache,
        );
        results.push(outcome);
      }
    } else {
      for (const student of candidates) {
        const outcome = await this.processPromotionForStudent(
          student,
          fromClass,
          toClass,
          isGraduating,
          isExpelling,
          isExplicitIds,
          dto.to_section_id,
          dto.reason,
          dto.target_academic_year,
          dryRun,
          classActiveCache,
          sectionActiveCache,
        );
        results.push(outcome);
      }
    }

    const total_promoted = results.filter((r) => r.status === 'promoted').length;
    const total_graduated = results.filter((r) => r.status === 'graduated').length;
    const total_expelled = results.filter((r) => r.status === 'expelled').length;
    const total_skipped = results.filter((r) => r.status === 'skipped').length;
    const total_failed = results.filter((r) => r.status === 'failed').length;

    return {
      summary: {
        total_requested: results.length,
        total_promoted: total_promoted + total_graduated + total_expelled,
        total_promoted_only: total_promoted,
        total_graduated,
        total_expelled,
        total_skipped,
        total_failed,
        dry_run: dryRun,
        mode: isGraduating ? 'graduation' : isExpelling ? 'expulsion' : 'promotion',
      },
      from_class: fromClass,
      to_class: toClass,
      results,
    };
  }

  private async processPromotionForStudent(
    student: {
      cc: number;
      class_id: number | null;
      section_id: number | null;
      campus_id: number | null;
      academic_year: string | null;
      status: string;
    },
    fromClass: ResolvedClass,
    toClass: ResolvedClass | null,
    isGraduating: boolean,
    isExpelling: boolean,
    isExplicitIds: boolean,
    toSectionId: number | undefined,
    reason: string | undefined,
    targetAcademicYear: string | undefined,
    dryRun: boolean,
    classActiveCache: Map<string, boolean>,
    sectionActiveCache: Map<string, boolean>,
  ): Promise<PromotionOutcome> {
    // ── Already expelled guard ───────────────────────────────────────────────
    if (student.status === StudentStatus.EXPELLED) {
      return {
        student_id: student.cc,
        status: 'skipped',
        reason_code: 'ALREADY_EXPELLED',
        message: isExpelling
          ? 'Student is already expelled'
          : 'Expelled student cannot be promoted',
        from_class_id: student.class_id,
        to_class_id: student.class_id,
        from_academic_year: student.academic_year,
        expelled: true,
        dry_run: dryRun,
      };
    }

    // ── Already graduated guard ──────────────────────────────────────────────
    if (student.status === StudentStatus.GRADUATED) {
      return {
        student_id: student.cc,
        status: 'skipped',
        reason_code: 'ALREADY_GRADUATED',
        message: 'Student is already graduated',
        from_class_id: student.class_id,
        to_class_id: toClass?.id ?? null,
        from_academic_year: student.academic_year,
        graduated: true,
        dry_run: dryRun,
      };
    }

    // ── From-class mismatch ──────────────────────────────────────────────────
    // For bulk (no explicit IDs): strict failure — the student shouldn't be in this batch.
    // For explicit IDs: softer skip — the caller asked for this specific student
    // but they're not in the expected class. Log it but don't inflate failure count.
    if (student.class_id !== fromClass.id) {
      return {
        student_id: student.cc,
        status: isExplicitIds ? 'skipped' : 'failed',
        reason_code: 'FROM_CLASS_MISMATCH',
        message: isExplicitIds
          ? `Student is in a different class (id=${student.class_id}) — skipped`
          : 'Student is not currently assigned to the selected from class',
        from_class_id: student.class_id,
        to_class_id: toClass?.id ?? null,
        from_academic_year: student.academic_year,
        dry_run: dryRun,
      };
    }

    // ── Compute target academic year ─────────────────────────────────────────
    // Priority: explicit request override > auto-increment from student's year
    const nextAcademicYear = targetAcademicYear?.trim()
      ? targetAcademicYear.trim()
      : this.incrementAcademicYear(student.academic_year);

    // ── Already at target guard ──────────────────────────────────────────────
    if (!isGraduating && toClass) {
      // Student is already in target class AND already has the target academic year
      if (student.class_id === toClass.id && student.academic_year === nextAcademicYear) {
        return {
          student_id: student.cc,
          status: 'skipped',
          reason_code: 'ALREADY_AT_TARGET',
          message: 'Student is already in the target class and academic year',
          from_class_id: student.class_id,
          to_class_id: toClass.id,
          from_academic_year: student.academic_year,
          to_academic_year: nextAcademicYear,
          dry_run: dryRun,
        };
      }
    }

    // ── Campus/class mapping validation (promotion only) ─────────────────────
    if (!isGraduating && toClass) {
      const mappingValidation = await this.validateTargetMapping(
        student.campus_id,
        toClass.id,
        toSectionId,
        classActiveCache,
        sectionActiveCache,
      );

      if (!mappingValidation.valid) {
        return {
          student_id: student.cc,
          status: 'failed',
          reason_code: mappingValidation.reason_code,
          message: mappingValidation.message,
          from_class_id: student.class_id,
          to_class_id: toClass.id,
          from_academic_year: student.academic_year,
          to_academic_year: nextAcademicYear,
          dry_run: dryRun,
        };
      }
    }

    // ── Dry-run early return ─────────────────────────────────────────────────
    if (dryRun) {
      return {
        student_id: student.cc,
        status: isGraduating ? 'graduated' : isExpelling ? 'expelled' : 'promoted',
        message: isGraduating
          ? 'Student validated for graduation (dry-run)'
          : isExpelling
          ? 'Student validated for expulsion (dry-run)'
          : 'Student validated successfully for promotion (dry-run)',
        from_class_id: student.class_id,
        to_class_id: isGraduating ? null : toClass?.id ?? student.class_id,
        from_academic_year: student.academic_year,
        to_academic_year: isExpelling ? undefined : nextAcademicYear,
        graduated: isGraduating,
        expelled: isExpelling,
        dry_run: true,
      };
    }

    // ── Commit to DB ─────────────────────────────────────────────────────────
    try {
      if (isGraduating) {
        // Graduation: set status to GRADUATED, null out class_id, all other data preserved
        await this.prisma.$transaction(async (tx) => {
          await tx.students.update({
            where: { cc: student.cc },
            data: {
              status: StudentStatus.GRADUATED,
              class_id: null,
              academic_year: nextAcademicYear,
            },
          });

          await tx.student_flags.create({
            data: {
              student_id: student.cc,
              flag: `GRADUATED_LOG_${Date.now()}`,
              reminder_date: new Date(),
              work_done: true,
              comment: reason?.trim() || null,
            },
          });
        });
        return {
          student_id: student.cc,
          status: 'graduated',
          message: 'Student graduated successfully',
          from_class_id: student.class_id,
          to_class_id: null,
          from_academic_year: student.academic_year,
          to_academic_year: nextAcademicYear,
          graduated: true,
          dry_run: false,
        };
      } else if (isExpelling) {
        // Expulsion: set status to EXPELLED and store expulsion metadata.
        const expulsionDate = new Date();
        const expulsionReason = reason?.trim() || null;

        await this.prisma.$transaction(async (tx) => {
          await tx.students.update({
            where: { cc: student.cc },
            data: { status: StudentStatus.EXPELLED },
          });

          await tx.student_flags.upsert({
            where: {
              student_id_flag: {
                student_id: student.cc,
                flag: 'EXPELLED',
              },
            },
            update: {
              reminder_date: expulsionDate,
              comment: expulsionReason,
              work_done: false,
            },
            create: {
              student_id: student.cc,
              flag: 'EXPELLED',
              reminder_date: expulsionDate,
              comment: expulsionReason,
              work_done: false,
            },
          });
        });

        return {
          student_id: student.cc,
          status: 'expelled',
          message: 'Student expelled successfully',
          from_class_id: student.class_id,
          to_class_id: student.class_id, // unchanged
          from_academic_year: student.academic_year,
          expelled: true,
          dry_run: false,
        };
      } else {
        // Normal promotion
        await this.prisma.$transaction(
          async (tx) => {
            await tx.students.update({
              where: { cc: student.cc },
              data: {
                class_id: toClass!.id,
                section_id: toSectionId !== undefined ? toSectionId : student.section_id,
                academic_year: nextAcademicYear,
              },
            });

            await tx.student_admissions.create({
              data: {
                student_id: student.cc,
                academic_system: toClass!.academic_system,
                requested_grade: toClass!.description,
                academic_year: nextAcademicYear,
              },
            });
          },
          { maxWait: 5000, timeout: 15000 },
        );

        return {
          student_id: student.cc,
          status: 'promoted',
          message: 'Student promoted successfully',
          from_class_id: student.class_id,
          to_class_id: toClass!.id,
          from_academic_year: student.academic_year,
          to_academic_year: nextAcademicYear,
          dry_run: false,
        };
      }
    } catch {
      return {
        student_id: student.cc,
        status: 'failed',
        reason_code: 'INTERNAL_ERROR',
        message: 'Unexpected error occurred during promotion/graduation/expulsion',
        from_class_id: student.class_id,
        to_class_id: toClass?.id ?? null,
        from_academic_year: student.academic_year,
        to_academic_year: nextAcademicYear,
        dry_run: false,
      };
    }
  }

  private async resolveClassSelector(
    selector: ClassSelectorDto,
    fieldName: 'from' | 'to',
  ): Promise<ResolvedClass> {
    if (!selector || (selector.class_id === undefined && !selector.class_label?.trim())) {
      throw new BadRequestException(`${fieldName} selector requires class_id or class_label`);
    }

    if (selector.class_id !== undefined) {
      const cls = await this.prisma.classes.findUnique({
        where: { id: selector.class_id },
        select: {
          id: true,
          description: true,
          class_code: true,
          academic_system: true,
        },
      });

      if (!cls) {
        throw new BadRequestException(`${fieldName} class not found for class_id=${selector.class_id}`);
      }

      return cls;
    }

    const label = selector.class_label!.trim();
    const cls = await this.prisma.classes.findFirst({
      where: {
        OR: [
          { description: { equals: label, mode: 'insensitive' } },
          { class_code: { equals: label, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        description: true,
        class_code: true,
        academic_system: true,
      },
    });

    if (!cls) {
      throw new BadRequestException(`${fieldName} class not found for class_label=${label}`);
    }

    return cls;
  }

  private async validateTargetMapping(
    campusId: number | null,
    toClassId: number,
    toSectionId: number | undefined,
    classActiveCache: Map<string, boolean>,
    sectionActiveCache: Map<string, boolean>,
  ): Promise<{ valid: true } | { valid: false; reason_code: PromotionReasonCode; message: string }> {
    if (!campusId) {
      return { valid: true };
    }

    const classKey = `${campusId}:${toClassId}`;
    let classIsActive = classActiveCache.get(classKey);
    if (classIsActive === undefined) {
      const mapping = await this.prisma.campus_classes.findFirst({
        where: {
          campus_id: campusId,
          class_id: toClassId,
          is_active: true,
        },
        select: { id: true },
      });
      classIsActive = !!mapping;
      classActiveCache.set(classKey, classIsActive);
    }

    if (!classIsActive) {
      return {
        valid: false,
        reason_code: 'TARGET_CLASS_INACTIVE_FOR_CAMPUS',
        message: 'Target class is not active for the student campus',
      };
    }

    if (toSectionId === undefined) {
      return { valid: true };
    }

    const sectionKey = `${campusId}:${toClassId}:${toSectionId}`;
    let sectionIsActive = sectionActiveCache.get(sectionKey);
    if (sectionIsActive === undefined) {
      const sectionMapping = await this.prisma.campus_sections.findFirst({
        where: {
          campus_id: campusId,
          class_id: toClassId,
          section_id: toSectionId,
          is_active: true,
        },
        select: { id: true },
      });
      sectionIsActive = !!sectionMapping;
      sectionActiveCache.set(sectionKey, sectionIsActive);
    }

    if (!sectionIsActive) {
      return {
        valid: false,
        reason_code: 'TARGET_SECTION_INVALID_FOR_CLASS_CAMPUS',
        message: 'Target section is not valid for the target class and campus',
      };
    }

    return { valid: true };
  }

  private incrementAcademicYear(currentAcademicYear: string | null): string {
    // YYYY-YYYY range format (e.g. "2024-2025" → "2025-2026")
    const yearRangeMatch = currentAcademicYear?.match(/^(\d{4})-(\d{4})$/);
    if (yearRangeMatch) {
      const start = Number(yearRangeMatch[1]);
      const end = Number(yearRangeMatch[2]);
      return `${start + 1}-${end + 1}`;
    }

    // Single YYYY format (e.g. "2024" → "2025-2026")
    const yearOnlyMatch = currentAcademicYear?.match(/^(\d{4})$/);
    if (yearOnlyMatch) {
      const year = Number(yearOnlyMatch[1]);
      return `${year + 1}-${year + 2}`;
    }

    // Fallback: use next calendar year as start
    const fallbackStartYear = new Date().getFullYear() + 1;
    return `${fallbackStartYear}-${fallbackStartYear + 1}`;
  }

  async searchSimple(query: string) {
    const isNumeric = /^\d+$/.test(query);
    const results: any[] = [];

    // 1. Check for exact CC match if query is numeric
    if (isNumeric) {
      const exactMatch = await this.prisma.students.findFirst({
        where: { cc: Number(query), deleted_at: null },
        select: {
          cc: true,
          full_name: true,
          gr_number: true,
        },
      });
      if (exactMatch) results.push(exactMatch);
    }

    // 2. Fetch partial matches for names and GR numbers
    const where: Prisma.studentsWhereInput = {
      deleted_at: null,
      OR: [
        { full_name: { contains: query, mode: 'insensitive' } },
        { gr_number: { contains: query, mode: 'insensitive' } },
      ],
    };

    // Exclude exact match if already added
    if (results.length > 0) {
      where.NOT = { cc: results[0].cc };
    }

    const others = await this.prisma.students.findMany({
      where,
      take: 5 - results.length,
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
      },
      orderBy: { full_name: 'asc' },
    });

    return [...results, ...others];
  }
}
