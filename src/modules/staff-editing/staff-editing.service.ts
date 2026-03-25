import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { GetSheetStudentsDto } from './dto/get-sheet-students.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { CreateGuardianDto } from './dto/create-guardian.dto';
import { UpdateGuardianDto } from './dto/update-guardian.dto';
import { UpdateGuardianRelationshipDto } from './dto/update-guardian-relationship.dto';

@Injectable()
export class StaffEditingService {
  constructor(private readonly prisma: PrismaService) { }

  // ─── Date Helpers ─────────────────────────────────────────────────────────

  private formatDateToFrontend(date: Date | null): string | null {
    if (!date) return null;
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  }

  private parseDateFromFrontend(dateStr: string | null): Date | null {
    if (!dateStr) return null;
    const parts = dateStr.split('/');
    if (parts.length !== 3) return new Date(dateStr); // Fallback to native parsing
    const [day, month, year] = parts;
    return new Date(`${year}-${month}-${day}`);
  }

  // ─── Students ─────────────────────────────────────────────────────────────

  async getStudents(dto: GetSheetStudentsDto) {
    const { cursor, limit = 50, search, campus_id, class_id, section_id, filterEmptyFields } = dto;

    const baseWhere: Prisma.studentsWhereInput = { deleted_at: null };

    if (search) {
      baseWhere.OR = [
        { full_name: { contains: search, mode: 'insensitive' } },
        { gr_number: { contains: search, mode: 'insensitive' } },
        ...(/^\d+$/.test(search) ? [{ cc: Number(search) }] : []),
      ];
    }

    if (campus_id) baseWhere.campus_id = campus_id;
    if (class_id) baseWhere.class_id = class_id;
    if (section_id) baseWhere.section_id = section_id;

    if (filterEmptyFields) {
      const emptyFieldsQuery: Prisma.studentsWhereInput[] = [
        { full_name: "" },
        { gr_number: null },
        { gr_number: "" },
        // Father Name empty: No father linked OR linked father has empty name
        {
          NOT: {
            student_guardians: {
              some: {
                relationship: { contains: 'FATHER', mode: 'insensitive' },
                guardians: {
                  full_name: { not: "" },
                },
              },
            },
          },
        },
        // Father CNIC empty: No father linked OR linked father has empty CNIC
        {
          NOT: {
            student_guardians: {
              some: {
                relationship: { contains: 'FATHER', mode: 'insensitive' },
                guardians: {
                  AND: [
                    { cnic: { not: null } },
                    { cnic: { not: "" } },
                  ],
                },
              },
            },
          },
        },
        // Mother CNIC empty: No mother linked OR linked mother has empty CNIC
        {
          NOT: {
            student_guardians: {
              some: {
                relationship: { contains: 'MOTHER', mode: 'insensitive' },
                guardians: {
                  AND: [
                    { cnic: { not: null } },
                    { cnic: { not: "" } },
                  ],
                },
              },
            },
          },
        },
      ];

      // If search is also present, we need to AND the search results with the empty fields OR list
      if (baseWhere.OR) {
        baseWhere.AND = [{ OR: baseWhere.OR }, { OR: emptyFieldsQuery }];
        delete baseWhere.OR;
      } else {
        baseWhere.OR = emptyFieldsQuery;
      }
    }

    // Cursor pagination: WHERE cc > cursor ORDER BY cc ASC
    const where: Prisma.studentsWhereInput = cursor
      ? { AND: [baseWhere, { cc: { gt: cursor } }] }
      : baseWhere;

    const rows = await this.prisma.students.findMany({
      where,
      take: limit,
      orderBy: { cc: 'asc' },
      select: {
        cc: true,
        gr_number: true,
        full_name: true,
        dob: true,
        gender: true,
        nationality: true,
        religion: true,
        status: true,
        whatsapp_number: true,
        whatsapp_country_code: true,
        primary_phone: true,
        primary_phone_country_code: true,
        email: true,
        campus_id: true,
        class_id: true,
        section_id: true,
        house_id: true,
        admission_age_years: true,
        academic_year: true,
        country: true,
        province: true,
        city: true,
        physical_impairment: true,
        consent_publicity: true,
        identification_marks: true,
        medical_info: true,
        interests: true,
        photograph_url: true,
        campuses: { select: { campus_name: true, campus_code: true } },
        classes: { select: { description: true, class_code: true } },
        sections: { select: { description: true } },
        houses: { select: { house_name: true } },
        student_guardians: {
          select: {
            relationship: true,
            guardians: { select: { full_name: true, cnic: true } }
          }
        },
        student_admissions: {
          orderBy: { application_date: 'desc' },
          take: 1,
        },
      },
    });

    const hasMore = rows.length === limit;
    const nextCursor = hasMore ? (rows[rows.length - 1]?.cc ?? null) : null;
    const items = rows.map((s) => this.flattenStudent(s));

    return { items, hasMore, nextCursor };
  }

  async getStudent(cc: number) {
    const s = await this.prisma.students.findUnique({
      where: { cc },
      include: {
        campuses: { select: { campus_name: true, campus_code: true } },
        classes: { select: { description: true, class_code: true } },
        sections: { select: { description: true } },
        houses: { select: { house_name: true } },
        student_admissions: {
          orderBy: { application_date: 'desc' },
          take: 1,
        },
        student_guardians: {
          include: { guardians: true },
          orderBy: { guardian_id: 'asc' },
        },
      },
    });

    if (!s || s.deleted_at) throw new NotFoundException(`Student #${cc} not found`);

    return this.flattenStudentFull(s);
  }

  async updateStudent(cc: number, dto: UpdateStudentDto) {
    const {
      dob,
      father_name,
      father_cnic,
      mother_name,
      mother_cnic,
      ...rest
    } = dto;

    const studentData: Record<string, unknown> = {
      ...rest,
      ...(dob !== undefined ? { dob: new Date(dob) } : {}),
    };

    try {
      await this.prisma.$transaction(async (tx) => {
        // 1. Update student fields
        if (Object.keys(studentData).length > 0) {
          await tx.students.update({
            where: { cc },
            data: studentData as any,
          });
        }

        // Fetch all current guardian links to match in JS
        const allLinks = await tx.student_guardians.findMany({
          where: { student_id: cc },
        });

        const isFather = (rel: string) => {
          const r = (rel || '').trim().toUpperCase();
          return r === 'FATHER' || (r.includes('FATHER') && !r.includes('GRAND'));
        };
        const isMother = (rel: string) => {
          const r = (rel || '').trim().toUpperCase();
          return r === 'MOTHER' || (r.includes('MOTHER') && !r.includes('GRAND'));
        };

        // 2. Update/Create Father Info
        if (father_name !== undefined || father_cnic !== undefined) {
          const fatherLink = allLinks.find(l => isFather(l.relationship));

          if (fatherLink) {
            const guardianUpdate: any = {};
            if (father_name !== undefined) guardianUpdate.full_name = father_name;
            if (father_cnic !== undefined) guardianUpdate.cnic = (!father_cnic || father_cnic === "NULL") ? null : father_cnic;
            await tx.guardians.update({
              where: { id: fatherLink.guardian_id },
              data: guardianUpdate,
            });
          } else if (father_name !== undefined || father_cnic !== undefined) {
            const guardianData: any = {
              full_name: father_name || 'NOT PROVIDED',
              cnic: (!father_cnic || father_cnic === "NULL") ? null : father_cnic,
            };
            const guardian = guardianData.cnic
              ? await tx.guardians.upsert({
                where: { cnic: guardianData.cnic },
                update: { full_name: guardianData.full_name },
                create: guardianData,
              })
              : await tx.guardians.create({ data: guardianData });

            await tx.student_guardians.upsert({
              where: { student_id_guardian_id: { student_id: cc, guardian_id: guardian.id } },
              update: { relationship: 'FATHER' },
              create: { student_id: cc, guardian_id: guardian.id, relationship: 'FATHER' },
            });
          }
        }

        // 3. Update/Create Mother Info
        if (mother_name !== undefined || mother_cnic !== undefined) {
          const motherLink = allLinks.find(l => isMother(l.relationship));

          if (motherLink) {
            const guardianUpdate: any = {};
            if (mother_name !== undefined) guardianUpdate.full_name = mother_name;
            if (mother_cnic !== undefined) guardianUpdate.cnic = (!mother_cnic || mother_cnic === "NULL") ? null : mother_cnic;
            await tx.guardians.update({
              where: { id: motherLink.guardian_id },
              data: guardianUpdate,
            });
          } else if (mother_name !== undefined || mother_cnic !== undefined) {
            const guardianData: any = {
              full_name: mother_name || 'NOT PROVIDED',
              cnic: (!mother_cnic || mother_cnic === "NULL") ? null : mother_cnic,
            };
            const guardian = guardianData.cnic
              ? await tx.guardians.upsert({
                where: { cnic: guardianData.cnic },
                update: { full_name: guardianData.full_name },
                create: guardianData,
              })
              : await tx.guardians.create({ data: guardianData });

            await tx.student_guardians.upsert({
              where: { student_id_guardian_id: { student_id: cc, guardian_id: guardian.id } },
              update: { relationship: 'MOTHER' },
              create: { student_id: cc, guardian_id: guardian.id, relationship: 'MOTHER' },
            });
          }
        }
      });
    } catch (e: any) {
      if (e?.code === 'P2025')
        throw new NotFoundException(`Student #${cc} not found`);
      throw e;
    }

    // Return the updated spreadsheet row — guardian tree excluded for auto-save speed
    return this.fetchStudentRow(cc);
  }

  // Lightweight re-fetch for auto-save responses (no guardian tree loaded)
  private async fetchStudentRow(cc: number) {
    const s = await this.prisma.students.findUnique({
      where: { cc },
      select: {
        cc: true,
        gr_number: true,
        full_name: true,
        dob: true,
        gender: true,
        nationality: true,
        religion: true,
        status: true,
        whatsapp_number: true,
        whatsapp_country_code: true,
        primary_phone: true,
        primary_phone_country_code: true,
        email: true,
        campus_id: true,
        class_id: true,
        section_id: true,
        house_id: true,
        admission_age_years: true,
        academic_year: true,
        country: true,
        province: true,
        city: true,
        physical_impairment: true,
        consent_publicity: true,
        identification_marks: true,
        medical_info: true,
        interests: true,
        photograph_url: true,
        campuses: { select: { campus_name: true, campus_code: true } },
        classes: { select: { description: true, class_code: true } },
        sections: { select: { description: true } },
        houses: { select: { house_name: true } },
        student_guardians: {
          select: {
            relationship: true,
            guardians: { select: { full_name: true, cnic: true } }
          }
        },
        student_admissions: {
          orderBy: { application_date: 'desc' },
          take: 1,
        },
      },
    });
    return s ? this.flattenStudent(s) : null;
  }

  // ─── Guardians ────────────────────────────────────────────────────────────

  async getStudentGuardians(studentCc: number) {
    await this.assertStudentExists(studentCc);

    const links = await this.prisma.student_guardians.findMany({
      where: { student_id: studentCc },
      include: { guardians: true },
      orderBy: { guardian_id: 'asc' },
    });

    return links.map((link) => ({
      guardian_id: link.guardian_id,
      relationship: link.relationship,
      is_primary_contact: link.is_primary_contact,
      is_emergency_contact: link.is_emergency_contact,
      ...link.guardians,
      dob: this.formatDateToFrontend(link.guardians.dob),
    }));
  }

  async addGuardianToStudent(studentCc: number, dto: CreateGuardianDto) {
    await this.assertStudentExists(studentCc);

    const { relationship, is_primary_contact = false, is_emergency_contact = false, ...guardianFields } = dto;

    // Convert dob string to Date if present
    const guardianData: any = { ...guardianFields };
    if (guardianFields.dob) {
      guardianData.dob = this.parseDateFromFrontend(guardianFields.dob);
    }

    // Upsert by CNIC to prevent duplicates; create new if no CNIC provided.
    // No `select` — get the full guardian row back to avoid an extra round-trip.
    const guardian = guardianData.cnic
      ? await this.prisma.guardians.upsert({
        where: { cnic: guardianData.cnic as string },
        update: {},
        create: guardianData,
      })
      : await this.prisma.guardians.create({ data: guardianData });

    // Link to student — upsert handles re-adds without a duplicate key error
    const joinData = { relationship, is_primary_contact, is_emergency_contact };
    await this.prisma.student_guardians.upsert({
      where: {
        student_id_guardian_id: { student_id: studentCc, guardian_id: guardian.id },
      },
      update: joinData,
      create: { student_id: studentCc, guardian_id: guardian.id, ...joinData },
    });

    return {
      guardian_id: guardian.id,
      relationship,
      is_primary_contact,
      is_emergency_contact,
      ...guardian,
      dob: this.formatDateToFrontend(guardian.dob),
    };
  }

  async getGuardian(id: number) {
    const guardian = await this.prisma.guardians.findUnique({ where: { id } });
    if (!guardian) throw new NotFoundException(`Guardian #${id} not found`);
    return {
      ...guardian,
      dob: this.formatDateToFrontend(guardian.dob),
    };
  }

  async updateGuardian(id: number, dto: UpdateGuardianDto) {
    const { dob, ...rest } = dto;
    const data: Record<string, unknown> = {
      ...rest,
      ...(dob !== undefined
        ? { dob: this.parseDateFromFrontend(dob as string) }
        : {}),
    };

    try {
      const guardian = await this.prisma.guardians.update({
        where: { id },
        data: data as any,
      });
      return {
        ...guardian,
        dob: this.formatDateToFrontend(guardian.dob),
      };
    } catch (e: any) {
      if (e?.code === 'P2025') throw new NotFoundException(`Guardian #${id} not found`);
      throw e;
    }
  }

  async getGuardianByNic(nic: string) {
    const guardian = await this.prisma.guardians.findUnique({
      where: { cnic: nic },
    });
    if (!guardian) return null;
    return {
      ...guardian,
      dob: this.formatDateToFrontend(guardian.dob),
    };
  }

  async updateGuardianRelationship(
    studentCc: number,
    guardianId: number,
    dto: UpdateGuardianRelationshipDto,
  ) {
    const { relationship, is_primary_contact, is_emergency_contact, dob, ...guardianFields } = dto;

    const relationshipData: Prisma.student_guardiansUpdateInput = {};
    if (relationship !== undefined) relationshipData.relationship = relationship;
    if (is_primary_contact !== undefined) relationshipData.is_primary_contact = is_primary_contact;
    if (is_emergency_contact !== undefined) relationshipData.is_emergency_contact = is_emergency_contact;

    const guardianData: Record<string, any> = { ...guardianFields };
    if (dob !== undefined) {
      guardianData.dob = dob ? this.parseDateFromFrontend(dob as string) : null;
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Update relationship if any field provided
        if (Object.keys(relationshipData).length > 0) {
          await tx.student_guardians.update({
            where: {
              student_id_guardian_id: {
                student_id: studentCc,
                guardian_id: guardianId,
              },
            },
            data: relationshipData,
          });
        }

        // 2. Update guardian personal details if any field provided
        if (Object.keys(guardianData).length > 0) {
          await tx.guardians.update({
            where: { id: guardianId },
            data: guardianData,
          });
        }

        // Return combined view
        const link = await tx.student_guardians.findUnique({
          where: {
            student_id_guardian_id: {
              student_id: studentCc,
              guardian_id: guardianId,
            },
          },
          include: { guardians: true },
        });

        if (!link) throw new NotFoundException(`Link not found after update`);

        return {
          guardian_id: link.guardian_id,
          relationship: link.relationship,
          is_primary_contact: link.is_primary_contact,
          is_emergency_contact: link.is_emergency_contact,
          ...link.guardians,
          dob: this.formatDateToFrontend(link.guardians.dob),
        };
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(
          `No link between student #${studentCc} and guardian #${guardianId}`,
        );
      }
      throw e;
    }
  }

  async removeGuardianFromStudent(studentCc: number, guardianId: number) {
    try {
      await this.prisma.student_guardians.delete({
        where: {
          student_id_guardian_id: {
            student_id: studentCc,
            guardian_id: guardianId,
          },
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2025') {
        throw new NotFoundException(
          `No link between student #${studentCc} and guardian #${guardianId}`,
        );
      }
      throw e;
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async assertStudentExists(cc: number) {
    const s = await this.prisma.students.findUnique({
      where: { cc },
      select: { cc: true, deleted_at: true },
    });
    if (!s || s.deleted_at) throw new NotFoundException(`Student #${cc} not found`);
  }

  private flattenStudent(s: any) {
    const admission = s.student_admissions?.[0];
    const guardians = s.student_guardians || [];

    const isFather = (rel: string) => {
      const r = (rel || '').trim().toUpperCase();
      return r === 'FATHER' || (r.includes('FATHER') && !r.includes('GRAND'));
    };

    const isMother = (rel: string) => {
      const r = (rel || '').trim().toUpperCase();
      return r === 'MOTHER' || (r.includes('MOTHER') && !r.includes('GRAND'));
    };

    const fatherLink = guardians.find((g: any) => isFather(g.relationship));
    const motherLink = guardians.find((g: any) => isMother(g.relationship));

    return {
      cc: s.cc,
      gr_number: s.gr_number,
      full_name: s.full_name,
      dob: s.dob,
      gender: s.gender,
      nationality: s.nationality,
      religion: s.religion,
      status: s.status,
      whatsapp_number: s.whatsapp_number,
      whatsapp_country_code: s.whatsapp_country_code,
      primary_phone: s.primary_phone,
      primary_phone_country_code: s.primary_phone_country_code,
      email: s.email,
      campus_id: s.campus_id,
      campus_name: s.campuses?.campus_name ?? null,
      campus_code: s.campuses?.campus_code ?? null,
      class_id: s.class_id,
      class_name: s.classes?.description ?? null,
      class_code: s.classes?.class_code ?? null,
      section_id: s.section_id,
      section_name: s.sections?.description ?? null,
      house_id: s.house_id,
      house_name: s.houses?.house_name ?? null,
      admission_age_years: s.admission_age_years,
      country: s.country,
      province: s.province,
      city: s.city,
      physical_impairment: s.physical_impairment,
      consent_publicity: s.consent_publicity,
      identification_marks: s.identification_marks,
      medical_info: s.medical_info,
      interests: s.interests,
      photograph_url: s.photograph_url,
      requested_grade: admission?.requested_grade ?? null,
      academic_system: admission?.academic_system ?? null,
      academic_year: s.academic_year ?? admission?.academic_year ?? null,
      father_name: fatherLink?.guardians?.full_name ?? null,
      father_cnic: fatherLink?.guardians?.cnic ?? null,
      mother_name: motherLink?.guardians?.full_name ?? null,
      mother_cnic: motherLink?.guardians?.cnic ?? null,
    };
  }

  private flattenStudentFull(s: any) {
    const admission = s.student_admissions?.[0];
    return {
      cc: s.cc,
      gr_number: s.gr_number,
      full_name: s.full_name,
      dob: s.dob,
      gender: s.gender,
      nationality: s.nationality,
      religion: s.religion,
      status: s.status,
      whatsapp_number: s.whatsapp_number,
      whatsapp_country_code: s.whatsapp_country_code,
      primary_phone: s.primary_phone,
      primary_phone_country_code: s.primary_phone_country_code,
      email: s.email,
      campus_id: s.campus_id,
      campus_name: s.campuses?.campus_name ?? null,
      campus_code: s.campuses?.campus_code ?? null,
      class_id: s.class_id,
      class_name: s.classes?.description ?? null,
      class_code: s.classes?.class_code ?? null,
      section_id: s.section_id,
      section_name: s.sections?.description ?? null,
      house_id: s.house_id,
      house_name: s.houses?.house_name ?? null,
      admission_age_years: s.admission_age_years,
      country: s.country,
      province: s.province,
      city: s.city,
      physical_impairment: s.physical_impairment,
      consent_publicity: s.consent_publicity,
      identification_marks: s.identification_marks,
      medical_info: s.medical_info,
      interests: s.interests,
      photograph_url: s.photograph_url,
      requested_grade: admission?.requested_grade ?? null,
      academic_system: admission?.academic_system ?? null,
      academic_year: s.academic_year ?? admission?.academic_year ?? null,
      guardians: s.student_guardians?.map((link: any) => ({
        guardian_id: link.guardian_id,
        relationship: link.relationship,
        is_primary_contact: link.is_primary_contact,
        is_emergency_contact: link.is_emergency_contact,
        ...link.guardians,
      })) ?? [],
    };
  }
}
