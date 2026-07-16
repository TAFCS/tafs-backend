import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { GetSheetStudentsDto } from './dto/get-sheet-students.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { CreateGuardianDto } from './dto/create-guardian.dto';
import { UpdateGuardianDto } from './dto/update-guardian.dto';
import { UpdateGuardianRelationshipDto } from './dto/update-guardian-relationship.dto';
import { UpdateFamilyAddressDto } from './dto/update-family-address.dto';
import { LinkExistingGuardianDto } from './dto/link-existing-guardian.dto';

import { AuditLogsService } from '../audit-logs/audit-logs.service';

@Injectable()
export class StaffEditingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) { }

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
        cnic: true,
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
        family_id: true,
        home_phone: true,
        is_complementary: true,
        is_fee_endowment: true,
        fee_start_term: true,
        graduated_from_class_id: true,
        families: {
          select: { 
            id: true,
            household_name: true, 
            legacy_pid: true,
            home_phone: true
          }
        },
        admission_age_years: true,
        academic_year: true,
        place_of_birth: true,
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
        graduated_from_class: { select: { id: true, description: true, class_code: true } },
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
    const s: any = await this.prisma.students.findUnique({
      where: { cc },
      include: {
        campuses: true,
        classes: true,
        graduated_from_class: true,
        sections: true,
        houses: true,
        student_admissions: { orderBy: { application_date: 'desc' }, take: 5 },
        student_flags: { orderBy: { created_at: 'desc' } },
        student_guardians: { include: { guardians: true }, orderBy: { guardian_id: 'asc' } },
        student_activities: true,
        student_languages: true,
        student_previous_schools: { orderBy: { id: 'desc' } },
        student_alevel_details: true,
        families: {
          include: {
            students: {
              where: { deleted_at: null },
              include: {
                student_guardians: { include: { guardians: true } },
                student_admissions: { orderBy: { application_date: 'desc' }, take: 1 },
                classes: true,
                sections: true,
              }
            }
          }
        }
      },
    });

    if (!s || s.deleted_at) throw new NotFoundException(`Student #${cc} not found`);

    // Add inherited guardians if direct ones are missing
    if (s.student_guardians.length === 0 && s.family_id) {
       const inherited = await this.prisma.student_guardians.findMany({
         where: { students: { family_id: s.family_id } },
         include: { guardians: true },
         orderBy: { guardian_id: 'asc' }
       });
       // Deduplicate inherited guardians by CNIC or Name
       const seen = new Set();
       s.student_guardians = inherited.filter(link => {
         const key = link.guardians?.cnic || `${link.relationship}:${link.guardians?.full_name}`;
         if (seen.has(key)) return false;
         seen.add(key);
         return true;
       });
    }

    // ── Backfill graduated_from_class_id for legacy graduated students ───────
    if (s.status === 'GRADUATED' && !s.graduated_from_class) {
      const admission = s.student_admissions?.[0];
      let resolvedGradClass: { id: number; description: string; class_code: string } | null = null;

      if (admission?.requested_grade) {
        const grade = admission.requested_grade;
        const normalized = grade.replace(/[-\s]/g, '').toUpperCase();
        resolvedGradClass = await this.prisma.classes.findFirst({
          where: {
            OR: [
              { class_code: { equals: grade, mode: 'insensitive' } },
              { class_code: { equals: normalized, mode: 'insensitive' } },
              { description: { equals: grade, mode: 'insensitive' } },
              { description: { contains: grade, mode: 'insensitive' } },
            ],
          },
          select: { id: true, description: true, class_code: true },
        }) as any;
      }

      if (resolvedGradClass) {
        await this.prisma.students.update({
          where: { cc: s.cc },
          data: { graduated_from_class_id: resolvedGradClass.id },
        }).catch(() => { /* non-critical */ });
        s.graduated_from_class_id = resolvedGradClass.id;
        s.graduated_from_class = resolvedGradClass;
      }
    }

    const transferLog = await this.prisma.audit_logs.findFirst({
      where: {
        OR: [
          { student_id: cc, entity_type: 'TRANSFER' },
          { entity_id: String(cc), entity_type: 'TRANSFER' },
        ],
      },
      select: { id: true },
    });
    s.has_transfer = !!transferLog || (s.student_admissions && s.student_admissions.length > 1);

    return this.flattenStudentFull(s);
  }

  async updateStudent(cc: number, dto: UpdateStudentDto, changedBy: string) {
    const {
      dob,
      doa,
      father_name,
      father_cnic,
      mother_name,
      mother_cnic,
      ...rest
    } = dto;

    const studentData: Record<string, unknown> = {
      ...rest,
      ...(dob !== undefined ? { dob: new Date(dob) } : {}),
      ...(doa !== undefined ? { doa: doa ? new Date(doa) : null } : {}),
    };

    if (studentData.cnic !== undefined) {
      const c = typeof studentData.cnic === 'string' ? studentData.cnic.trim() : studentData.cnic;
      studentData.cnic = (!c || c === 'NULL' || c === 'XXXXX-XXXXXXX-X') ? null : c;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // Fetch existing record first for diff logging
        const existing = await tx.students.findUnique({
          where: { cc },
        });
        if (!existing) {
          throw new NotFoundException(`Student #${cc} not found`);
        }

        // Log student field changes
        const TRACKED_STUDENT_FIELDS = [
          'full_name', 'cnic', 'gender', 'nationality', 'religion',
          'place_of_birth', 'identification_marks', 'medical_info',
          'interests', 'country', 'province', 'city', 'whatsapp_number',
          'primary_phone', 'email', 'campus_id', 'class_id', 'section_id',
          'house_id', 'academic_year', 'gr_number', 'status', 'is_complementary',
          'is_fee_endowment'
        ];

        for (const field of TRACKED_STUDENT_FIELDS) {
          if ((dto as any)[field] !== undefined) {
            let oldVal: string | null = null;
            let newVal: string | null = null;

            if (field === 'dob' || field === 'doa') {
              const oldDate = (existing as any)[field];
              const newDateStr = (dto as any)[field];
              const newDate = newDateStr ? new Date(newDateStr) : null;
              if (oldDate?.getTime() !== newDate?.getTime()) {
                oldVal = oldDate ? oldDate.toISOString().split('T')[0] : null;
                newVal = newDate ? newDate.toISOString().split('T')[0] : null;
              }
            } else {
              const oldRaw = (existing as any)[field];
              const newRaw = (dto as any)[field];
              if (String(oldRaw ?? '') !== String(newRaw ?? '')) {
                oldVal = oldRaw !== null && oldRaw !== undefined ? String(oldRaw) : null;
                newVal = newRaw !== null && newRaw !== undefined ? String(newRaw) : null;
              }
            }

            if (oldVal !== null || newVal !== null) {
              await this.auditLogs.log({
                entity_type: 'STUDENT',
                entity_id: String(cc),
                action: 'UPDATED',
                field: `student.${field}`,
                old_value: oldVal,
                new_value: newVal,
                changed_by: changedBy,
                student_id: cc,
              });
            }
          }
        }

        // 1. Update student fields
        if (Object.keys(studentData).length > 0) {
          await tx.students.update({
            where: { cc },
            data: studentData as any,
          });
        }

        // Write academic history if class or section changed
        const classChanged = dto.class_id !== undefined && existing.class_id !== dto.class_id;
        const sectionChanged = dto.section_id !== undefined && existing.section_id !== dto.section_id;
        if (classChanged || sectionChanged) {
          await tx.student_academic_history.create({
            data: {
              student_cc: cc,
              class_id: dto.class_id !== undefined ? dto.class_id : existing.class_id,
              section_id: dto.section_id !== undefined ? dto.section_id : existing.section_id,
              campus_id: dto.campus_id !== undefined ? dto.campus_id : existing.campus_id,
              academic_year: (dto as any).academic_year ?? existing.academic_year,
              gr_number: (dto as any).gr_number ?? existing.gr_number,
              change_type: 'REASSIGNED',
              changed_by: changedBy,
            },
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
          const fCnic = typeof father_cnic === 'string' ? father_cnic.trim() : father_cnic;
          const fCnicNormalized = (!fCnic || fCnic === 'NULL' || fCnic === 'XXXXX-XXXXXXX-X') ? null : fCnic;

          if (fatherLink) {
            const guardianUpdate: any = {};
            if (father_name !== undefined) guardianUpdate.full_name = father_name;
            if (father_cnic !== undefined) guardianUpdate.cnic = fCnicNormalized;

            const existingFather = await tx.guardians.findUnique({ where: { id: fatherLink.guardian_id } });
            if (existingFather) {
              if (father_name !== undefined && String(existingFather.full_name ?? '') !== String(father_name)) {
                await this.auditLogs.log({
                  entity_type: 'GUARDIAN',
                  entity_id: String(existingFather.id),
                  action: 'UPDATED',
                  field: 'guardian.full_name',
                  old_value: existingFather.full_name,
                  new_value: father_name,
                  changed_by: changedBy,
                  student_id: cc,
                });
              }
              if (father_cnic !== undefined && String(existingFather.cnic ?? '') !== String(fCnicNormalized ?? '')) {
                await this.auditLogs.log({
                  entity_type: 'GUARDIAN',
                  entity_id: String(existingFather.id),
                  action: 'UPDATED',
                  field: 'guardian.cnic',
                  old_value: existingFather.cnic,
                  new_value: fCnicNormalized,
                  changed_by: changedBy,
                  student_id: cc,
                });
              }
            }

            await tx.guardians.update({
              where: { id: fatherLink.guardian_id },
              data: guardianUpdate,
            });
          } else if (father_name !== undefined || father_cnic !== undefined) {
            const guardianData: any = {
              full_name: father_name || 'NOT PROVIDED',
              cnic: fCnicNormalized,
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

            await this.auditLogs.log({
              entity_type: 'GUARDIAN',
              entity_id: String(guardian.id),
              action: 'CREATED',
              changed_by: changedBy,
              student_id: cc,
              note: `Created/linked Father guardian for student #${cc}`,
            });
          }
        }

        // 3. Update/Create Mother Info
        if (mother_name !== undefined || mother_cnic !== undefined) {
          const motherLink = allLinks.find(l => isMother(l.relationship));
          const mCnic = typeof mother_cnic === 'string' ? mother_cnic.trim() : mother_cnic;
          const mCnicNormalized = (!mCnic || mCnic === 'NULL' || mCnic === 'XXXXX-XXXXXXX-X') ? null : mCnic;

          if (motherLink) {
            const guardianUpdate: any = {};
            if (mother_name !== undefined) guardianUpdate.full_name = mother_name;
            if (mother_cnic !== undefined) guardianUpdate.cnic = mCnicNormalized;

            const existingMother = await tx.guardians.findUnique({ where: { id: motherLink.guardian_id } });
            if (existingMother) {
              if (mother_name !== undefined && String(existingMother.full_name ?? '') !== String(mother_name)) {
                await this.auditLogs.log({
                  entity_type: 'GUARDIAN',
                  entity_id: String(existingMother.id),
                  action: 'UPDATED',
                  field: 'guardian.full_name',
                  old_value: existingMother.full_name,
                  new_value: mother_name,
                  changed_by: changedBy,
                  student_id: cc,
                });
              }
              if (mother_cnic !== undefined && String(existingMother.cnic ?? '') !== String(mCnicNormalized ?? '')) {
                await this.auditLogs.log({
                  entity_type: 'GUARDIAN',
                  entity_id: String(existingMother.id),
                  action: 'UPDATED',
                  field: 'guardian.cnic',
                  old_value: existingMother.cnic,
                  new_value: mCnicNormalized,
                  changed_by: changedBy,
                  student_id: cc,
                });
              }
            }

            await tx.guardians.update({
              where: { id: motherLink.guardian_id },
              data: guardianUpdate,
            });
          } else if (mother_name !== undefined || mother_cnic !== undefined) {
            const guardianData: any = {
              full_name: mother_name || 'NOT PROVIDED',
              cnic: mCnicNormalized,
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

            await this.auditLogs.log({
              entity_type: 'GUARDIAN',
              entity_id: String(guardian.id),
              action: 'CREATED',
              changed_by: changedBy,
              student_id: cc,
              note: `Created/linked Mother guardian for student #${cc}`,
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
        is_complementary: true,
        is_fee_endowment: true,
        fee_start_term: true,
        graduated_from_class_id: true,
        admission_age_years: true,
        academic_year: true,
        place_of_birth: true,
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
        graduated_from_class: { select: { id: true, description: true, class_code: true } },
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

  async updateFamilyAddress(studentCc: number, dto: UpdateFamilyAddressDto, changedBy: string) {
    const { bulk_sync, ...addressData } = dto;
    
    // Find the current student's links
    const currentLinks = await this.prisma.student_guardians.findMany({
      where: { student_id: studentCc },
      select: { guardian_id: true }
    });
    const currentGuardianIds = currentLinks.map(l => l.guardian_id);

    const student = await this.prisma.students.findUnique({
      where: { cc: studentCc },
      select: { family_id: true }
    });
    const familyId = student?.family_id;

    // Log the family address change
    await this.auditLogs.log({
      entity_type: 'FAMILY',
      entity_id: familyId ? String(familyId) : String(studentCc),
      action: 'UPDATED',
      field: 'family.address',
      new_value: `Updated address to: ${dto.house_appt_name || ''}, ${dto.city || ''}`,
      changed_by: changedBy,
      student_id: studentCc,
      note: bulk_sync ? 'Bulk synced to all family members' : 'Individual update',
    });

    if (bulk_sync) {
      return this.prisma.$transaction(async (tx) => {
        if (student?.family_id) {
          await tx.families.update({
            where: { id: student.family_id },
            data: { home_phone: dto.work_phone }
          });
          
          // Find all guardians linked to ANY student in this family
          const familyLinks = await tx.student_guardians.findMany({
            where: {
              students: { family_id: student.family_id }
            },
            select: { guardian_id: true }
          });
          const uniqueIds = [...new Set(familyLinks.map(l => l.guardian_id))];
          
          if (uniqueIds.length > 0) {
            await tx.guardians.updateMany({
              where: { id: { in: uniqueIds } },
              data: addressData as any
            });
          }
          return { success: true, count: uniqueIds.length, target: 'household' };
        }
        return { success: false, message: 'No family found for bulk sync' };
      });
    }

    // Default or Fallback: Only update guardians of this specific student
    if (currentGuardianIds.length > 0) {
      await this.prisma.guardians.updateMany({
        where: { id: { in: currentGuardianIds } },
        data: addressData as any
      });
    }
    return { success: true, count: currentGuardianIds.length, target: 'individual' };
  }

  async getStudentGuardians(studentCc: number) {
    await this.assertStudentExists(studentCc);

    let links = await this.prisma.student_guardians.findMany({
      where: { student_id: studentCc },
      include: { guardians: true },
      orderBy: { guardian_id: 'asc' },
    });

    // Inheritance fallback: if no direct links, check family siblings
    if (links.length === 0) {
      const student = await this.prisma.students.findUnique({
        where: { cc: studentCc },
        select: { family_id: true },
      });

      if (student?.family_id) {
        links = await this.prisma.student_guardians.findMany({
          where: { students: { family_id: student.family_id } },
          include: { guardians: true },
          orderBy: { guardian_id: 'asc' },
        });
        // Deduplicate guardians by CNIC or Name to avoid repeats from duplicates in DB
        const seen = new Set();
        links = links.filter(link => {
          const key = link.guardians?.cnic || `${link.relationship}:${link.guardians?.full_name}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
    }

    return links.map((link) => ({
      guardian_id: link.guardian_id,
      relationship: link.relationship,
      is_primary_contact: link.is_primary_contact,
      is_emergency_contact: link.is_emergency_contact,
      ...(link.guardians || {}),
      dob: link.guardians ? this.formatDateToFrontend(link.guardians.dob) : null,
    }));
  }

  async addGuardianToStudent(studentCc: number, dto: CreateGuardianDto, changedBy: string) {
    await this.assertStudentExists(studentCc);

    const { relationship, is_primary_contact = false, is_emergency_contact = false, ...guardianFields } = dto;

    // Convert dob string to Date if present
    const guardianData: any = { ...guardianFields };
    if (guardianFields.email && !guardianFields.email_address) {
      guardianData.email_address = guardianFields.email;
      delete (guardianData as any).email;
    }
    if (guardianFields.dob) {
      guardianData.dob = this.parseDateFromFrontend(guardianFields.dob);
    }

    // Upsert by CNIC to prevent duplicates; create new if no CNIC provided.
    const isAddressEmpty = !guardianData.house_appt_name && !guardianData.city;

    if (isAddressEmpty) {
        // Try to inherit from family
        const student = await this.prisma.students.findUnique({
            where: { cc: studentCc },
            select: { family_id: true }
        });
        if (student?.family_id) {
            const familyMember = await this.prisma.student_guardians.findFirst({
                where: { students: { family_id: student.family_id } },
                include: { guardians: true }
            });
            if (familyMember?.guardians) {
                const g = familyMember.guardians;
                guardianData.house_appt_name = g.house_appt_name;
                guardianData.area_block = g.area_block;
                guardianData.city = g.city;
                guardianData.postal_code = g.postal_code;
                guardianData.province = g.province;
                guardianData.country = g.country;
                guardianData.work_phone = g.work_phone;
            }
        }
    }

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

    await this.auditLogs.log({
      entity_type: 'GUARDIAN',
      entity_id: String(guardian.id),
      action: 'CREATED',
      changed_by: changedBy,
      student_id: studentCc,
      note: `Added/linked guardian (${relationship}) to student #${studentCc}`,
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

  async linkExistingGuardian(studentCc: number, dto: LinkExistingGuardianDto, changedBy: string) {
    await this.assertStudentExists(studentCc);

    const { guardian_id, relationship, is_primary_contact = false, is_emergency_contact = false } = dto;

    const guardian = await this.prisma.guardians.findUnique({ where: { id: guardian_id } });
    if (!guardian) throw new NotFoundException(`Guardian #${guardian_id} not found`);

    const joinData = { relationship, is_primary_contact, is_emergency_contact };

    const link = await this.prisma.student_guardians.upsert({
      where: {
        student_id_guardian_id: { student_id: studentCc, guardian_id },
      },
      update: joinData,
      create: { student_id: studentCc, guardian_id, ...joinData },
      include: { guardians: true },
    });

    await this.auditLogs.log({
      entity_type: 'GUARDIAN',
      entity_id: String(guardian_id),
      action: 'UPDATED',
      changed_by: changedBy,
      student_id: studentCc,
      note: `Linked existing guardian #${guardian_id} (${relationship}) to student #${studentCc}`,
    });

    return {
      guardian_id: link.guardian_id,
      relationship: link.relationship,
      is_primary_contact: link.is_primary_contact,
      is_emergency_contact: link.is_emergency_contact,
      ...link.guardians,
      dob: this.formatDateToFrontend(link.guardians.dob),
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
  async updateGuardian(id: number, dto: UpdateGuardianDto, changedBy: string) {
    const existing = await this.prisma.guardians.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException(`Guardian #${id} not found`);

    const { dob, cnic, ...rest } = dto;
    const data: Record<string, unknown> = {
      ...rest,
    };
    
    if (cnic !== undefined) {
      data.cnic = (cnic && cnic !== "N/A") ? cnic : null;
    }

    if (dto.email && !dto.email_address) {
      data.email_address = dto.email;
      delete data.email;
    }
    if (dob !== undefined) {
      data.dob = dob ? this.parseDateFromFrontend(dob as string) : null;
    }

    // Log changes
    const TRACKED_GUARDIAN_FIELDS = [
      'full_name', 'primary_phone', 'whatsapp_number', 'cnic', 'email_address',
      'occupation', 'organization', 'house_appt_name', 'city', 'province', 'country'
    ];

    const links = await this.prisma.student_guardians.findMany({
      where: { guardian_id: id },
      select: { student_id: true }
    });

    for (const field of TRACKED_GUARDIAN_FIELDS) {
      const newValKey = field === 'email_address' && dto.email !== undefined ? 'email' : field;
      let newRaw = (dto as any)[newValKey];
      if (field === 'cnic' && cnic !== undefined) {
        newRaw = (cnic && cnic !== "N/A") ? cnic : null;
      }
      const oldRaw = (existing as any)[field];

      if (newRaw !== undefined && String(oldRaw ?? '') !== String(newRaw ?? '')) {
        const logData = {
          entity_type: 'GUARDIAN',
          entity_id: String(id),
          action: 'UPDATED',
          field: `guardian.${field}`,
          old_value: oldRaw ? String(oldRaw) : null,
          new_value: newRaw ? String(newRaw) : null,
          changed_by: changedBy,
        };

        if (links.length > 0) {
          for (const link of links) {
            await this.auditLogs.log({
              ...logData,
              student_id: link.student_id,
            });
          }
        } else {
          await this.auditLogs.log(logData);
        }
      }
    }

    // Diff DOB
    if (dob !== undefined) {
      const oldDob = existing.dob;
      const newDob = dob ? this.parseDateFromFrontend(dob as string) : null;
      if (oldDob?.getTime() !== newDob?.getTime()) {
        const logData = {
          entity_type: 'GUARDIAN',
          entity_id: String(id),
          action: 'UPDATED',
          field: 'guardian.dob',
          old_value: oldDob ? this.formatDateToFrontend(oldDob) : null,
          new_value: dob as string || null,
          changed_by: changedBy,
        };

        if (links.length > 0) {
          for (const link of links) {
            await this.auditLogs.log({
              ...logData,
              student_id: link.student_id,
            });
          }
        } else {
          await this.auditLogs.log(logData);
        }
      }
    }

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
    changedBy: string,
  ) {
    const { relationship, is_primary_contact, is_emergency_contact, dob, ...guardianFields } = dto;

    const relationshipData: Prisma.student_guardiansUpdateInput = {};
    if (relationship !== undefined) relationshipData.relationship = relationship;
    if (is_primary_contact !== undefined) relationshipData.is_primary_contact = is_primary_contact;
    if (is_emergency_contact !== undefined) relationshipData.is_emergency_contact = is_emergency_contact;

    const guardianData: Record<string, any> = { ...guardianFields };
    if (dto.email && !dto.email_address) {
      guardianData.email_address = dto.email;
      delete guardianData.email;
    }
    if (dob !== undefined) {
      guardianData.dob = dob ? this.parseDateFromFrontend(dob as string) : null;
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingLink = await tx.student_guardians.findUnique({
          where: {
            student_id_guardian_id: {
              student_id: studentCc,
              guardian_id: guardianId,
            },
          },
          include: { guardians: true },
        });
        if (!existingLink) {
          throw new NotFoundException(`No link between student #${studentCc} and guardian #${guardianId}`);
        }

        // Log relationship field changes
        const relationshipFields = ['relationship', 'is_primary_contact', 'is_emergency_contact'];
        for (const field of relationshipFields) {
          const newVal = (dto as any)[field];
          const oldVal = (existingLink as any)[field];
          if (newVal !== undefined && String(oldVal ?? '') !== String(newVal ?? '')) {
            await this.auditLogs.log({
              entity_type: 'GUARDIAN',
              entity_id: String(guardianId),
              action: 'UPDATED',
              field: `guardian.${field}`,
              old_value: oldVal !== null && oldVal !== undefined ? String(oldVal) : null,
              new_value: newVal !== null && newVal !== undefined ? String(newVal) : null,
              changed_by: changedBy,
              student_id: studentCc,
            });
          }
        }

        // Log guardian personal field changes
        const TRACKED_GUARDIAN_FIELDS = [
          'full_name', 'primary_phone', 'whatsapp_number', 'cnic', 'email_address',
          'occupation', 'organization', 'house_appt_name', 'city', 'province', 'country'
        ];

        for (const field of TRACKED_GUARDIAN_FIELDS) {
          const newValKey = field === 'email_address' && dto.email !== undefined ? 'email' : field;
          const newVal = (dto as any)[newValKey];
          const oldVal = (existingLink.guardians as any)[field];

          if (newVal !== undefined && String(oldVal ?? '') !== String(newVal ?? '')) {
            await this.auditLogs.log({
              entity_type: 'GUARDIAN',
              entity_id: String(guardianId),
              action: 'UPDATED',
              field: `guardian.${field}`,
              old_value: oldVal ? String(oldVal) : null,
              new_value: newVal ? String(newVal) : null,
              changed_by: changedBy,
              student_id: studentCc,
            });
          }
        }

        // Diff DOB
        if (dob !== undefined) {
          const oldDob = existingLink.guardians.dob;
          const newDob = dob ? this.parseDateFromFrontend(dob as string) : null;
          if (oldDob?.getTime() !== newDob?.getTime()) {
            await this.auditLogs.log({
              entity_type: 'GUARDIAN',
              entity_id: String(guardianId),
              action: 'UPDATED',
              field: 'guardian.dob',
              old_value: oldDob ? this.formatDateToFrontend(oldDob) : null,
              new_value: dob as string || null,
              changed_by: changedBy,
              student_id: studentCc,
            });
          }
        }

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
      if (e?.code === 'P2025' || e instanceof NotFoundException) {
        throw new NotFoundException(
          `No link between student #${studentCc} and guardian #${guardianId}`,
        );
      }
      throw e;
    }
  }

  async removeGuardianFromStudent(studentCc: number, guardianId: number, changedBy: string) {
    try {
      await this.prisma.student_guardians.delete({
        where: {
          student_id_guardian_id: {
            student_id: studentCc,
            guardian_id: guardianId,
          },
        },
      });

      await this.auditLogs.log({
        entity_type: 'GUARDIAN',
        entity_id: String(guardianId),
        action: 'DELETED',
        changed_by: changedBy,
        student_id: studentCc,
        note: `Unlinked guardian #${guardianId} from student #${studentCc}`,
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
      cnic: s.cnic,
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
      place_of_birth: s.place_of_birth,
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
      family_id: s.family_id,
      home_phone: s.families?.home_phone || s.home_phone || null,
      household_name: s.families?.household_name ?? null,
      father_name: fatherLink?.guardians?.full_name ?? null,
      father_cnic: fatherLink?.guardians?.cnic ?? null,
      mother_name: motherLink?.guardians?.full_name ?? null,
      mother_cnic: motherLink?.guardians?.cnic ?? null,
      is_complementary: s.is_complementary,
      is_fee_endowment: s.is_fee_endowment,
      fee_start_term: s.fee_start_term,
      graduated_from_class_id: s.graduated_from_class_id,
      graduated_from_class: s.graduated_from_class ? {
        id: s.graduated_from_class.id,
        description: s.graduated_from_class.description,
        class_code: s.graduated_from_class.class_code
      } : null,
    };
  }

  private flattenStudentFull(s: any) {
    const admission = s.student_admissions?.[0];
    const actionLogs = this.buildStudentActionLogs(s);
    return {
      cc: s.cc,
      gr_number: s.gr_number,
      cnic: s.cnic,
      full_name: s.full_name,
      dob: s.dob,
      gender: s.gender,
      nationality: s.nationality,
      religion: s.religion,
      place_of_birth: s.place_of_birth ?? null,
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
      house_color: s.houses?.house_color ?? null,
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
      // Latest for backward compat
      requested_grade: admission?.requested_grade ?? null,
      academic_system: admission?.academic_system ?? null,
      academic_year: s.academic_year ?? admission?.academic_year ?? null,
      // All sub-tables
      has_transfer: !!s.has_transfer,
      admissions: s.student_admissions ?? [],
      activities: s.student_activities ?? [],
      languages: s.student_languages ?? [],
      previous_schools: s.student_previous_schools ?? [],
      alevel_details: s.student_alevel_details?.details ?? null,
      action_logs: actionLogs,
      guardians: s.student_guardians?.map((link: any) => ({
        guardian_id: link.guardian_id,
        relationship: link.relationship,
        is_primary_contact: link.is_primary_contact,
        is_emergency_contact: link.is_emergency_contact,
        ...(link.guardians || {}),
        dob: link.guardians ? this.formatDateToFrontend(link.guardians.dob) : null,
      })) ?? [],
      date_of_admission: s.doa,
      family_id: s.family_id,
      home_phone: s.families?.home_phone || s.home_phone || null,
      household_name: s.families?.household_name ?? null,
      families: s.families ? {
        id: s.families.id,
        household_name: s.families.household_name,
        legacy_pid: s.families.legacy_pid,
        home_phone: s.families.home_phone,
        students: s.families.students || []
      } : null,
      siblings: (s.families?.students || [])
        .filter((sib: any) => sib.cc !== s.cc)
        .map((sib: any) => ({
          id: sib.cc,
          cc: sib.cc,
          full_name: sib.full_name,
          cc_number: sib.cc,
          gr_number: sib.gr_number,
          grade: sib.classes
            ? `${sib.classes.description}${sib.sections ? ` (${sib.sections.description})` : ''}`
            : sib.student_admissions?.[0]?.requested_grade,
          status: sib.status,
          father_name: sib.student_guardians?.find((sg: any) => {
            const r = (sg.relationship || '').trim().toUpperCase();
            return r === 'FATHER' || (r.includes('FATHER') && !r.includes('GRAND'));
          })?.guardians?.full_name ?? null,
        })),
      is_complementary: s.is_complementary,
      is_fee_endowment: s.is_fee_endowment,
      fee_start_term: s.fee_start_term,
      graduated_from_class_id: s.graduated_from_class_id,
      graduated_from_class: s.graduated_from_class,
    };
  }

  private buildStudentActionLogs(s: any) {
    const logs: Array<{
      id: string;
      type: string;
      title: string;
      description?: string | null;
      occurred_at: Date | null;
    }> = [];

    if (s.created_at) {
      logs.push({
        id: `student-created-${s.cc}`,
        type: 'PROFILE_CREATED',
        title: 'Student profile created',
        description: null,
        occurred_at: s.created_at,
      });
    }

    const admissions = [...(s.student_admissions ?? [])].sort((a: any, b: any) => {
      const at = a?.application_date ? new Date(a.application_date).getTime() : 0;
      const bt = b?.application_date ? new Date(b.application_date).getTime() : 0;
      return at - bt;
    });

    admissions.forEach((admission: any, index: number) => {
      const isFirstAdmission = index === 0;
      const grade = admission?.requested_grade || 'Unknown grade';
      const title = isFirstAdmission
        ? `Admission recorded in ${grade}`
        : `Promoted to ${grade}`;
      const details = [admission?.academic_system, admission?.academic_year]
        .filter(Boolean)
        .join(' • ');

      logs.push({
        id: `admission-${admission.id}`,
        type: isFirstAdmission ? 'ADMISSION' : 'PROMOTION',
        title,
        description: details || null,
        occurred_at: admission?.application_date ?? null,
      });
    });

    for (const flag of s.student_flags ?? []) {
      const rawFlag = String(flag?.flag || '');
      const upperFlag = rawFlag.toUpperCase();

      // Unified status-change log matching — covers both legacy and new changeStatus patterns
      const statusFlagConfig: Array<{ test: (f: string) => boolean; type: string; title: string }> = [
        { test: f => f.startsWith('ENROLLED_LOG_'),       type: 'ENROLLED',       title: 'Student enrolled' },
        { test: f => f.startsWith('QUICK_ADMISSION_LOG_'), type: 'QUICK_ADMISSION', title: 'Quick admission recorded' },
        { test: f => f.startsWith('SOFT_ADMISSION_LOG_'), type: 'SOFT_ADMISSION', title: 'Soft admission recorded' },
        { test: f => f.startsWith('LEFT_LOG_'),           type: 'LEFT',           title: 'Student left' },
        { test: f => f.startsWith('UNDO_LEFT_LOG_'),      type: 'UNDO_LEFT',      title: 'Student re-enrolled (left undone)' },
        { test: f => f === 'EXPELLED' || f.startsWith('EXPELLED_LOG_'), type: 'EXPELLED',   title: 'Student expelled' },
        { test: f => f.startsWith('UNEXPELLED_LOG_'),     type: 'UNEXPELLED',     title: 'Student unexpelled' },
        { test: f => f.startsWith('GRADUATED_LOG_'),      type: 'GRADUATED',      title: 'Student graduated' },
        { test: f => f.startsWith('PROMOTION_LOG_'),      type: 'PROMOTION',      title: 'Student promoted' },
      ];

      const matched = statusFlagConfig.find(cfg => cfg.test(upperFlag));
      if (matched) {
        logs.push({
          id: `flag-${flag.id}`,
          type: matched.type,
          title: matched.title,
          description: flag?.comment || null,
          occurred_at: flag?.created_at ?? flag?.reminder_date ?? null,
        });
      }
    }

    logs.sort((a, b) => {
      const at = a.occurred_at ? new Date(a.occurred_at).getTime() : 0;
      const bt = b.occurred_at ? new Date(b.occurred_at).getTime() : 0;
      return bt - at;
    });

    return logs;
  }

  // ─── Sub-table CRUD ────────────────────────────────────────────────────────

  async upsertAdmission(studentId: number, dto: any) {
    const data: any = {
      student_id: studentId,
      academic_system: dto.academic_system,
      requested_grade: dto.requested_grade,
      academic_year: dto.academic_year,
      application_date: dto.application_date ? new Date(dto.application_date) : new Date(),
    };

    return await this.prisma.$transaction(async (tx) => {
      if (dto.id) {
        return tx.student_admissions.update({ where: { id: dto.id }, data });
      }
      return tx.student_admissions.create({
        data: {
          ...data,
          requested_grade: dto.requested_grade ?? '',
        },
      });
    });
  }

  async deleteAdmission(id: number) {
    const admission = await this.prisma.student_admissions.findUnique({ where: { id } });
    if (!admission) return null;

    return this.prisma.student_admissions
      .delete({ where: { id } })
      .then(() => ({ success: true }))
      .catch(() => null);
  }

  async upsertActivity(studentId: number, dto: any) {
    const data: any = {
      student_id: studentId,
      activity_name: dto.activity_name,
      grade: dto.grade,
      honors_awards: dto.honors_awards,
      continue_at_tafs: dto.continue_at_tafs ?? true,
    };
    if (dto.id) {
      return this.prisma.student_activities.update({ where: { id: dto.id }, data });
    }
    return this.prisma.student_activities.create({ data });
  }

  async deleteActivity(id: number) {
    return this.prisma.student_activities.delete({ where: { id } }).catch(() => null);
  }

  async upsertLanguage(studentId: number, dto: any) {
    const data: any = {
      student_id: studentId,
      language_name: dto.language_name,
      can_speak: dto.can_speak ?? false,
      can_read: dto.can_read ?? false,
      can_write: dto.can_write ?? false,
    };
    if (dto.id) {
      return this.prisma.student_languages.update({ where: { id: dto.id }, data });
    }
    return this.prisma.student_languages.create({ data });
  }

  async deleteLanguage(id: number) {
    return this.prisma.student_languages.delete({ where: { id } }).catch(() => null);
  }

  async upsertPreviousSchool(studentId: number, dto: any) {
    const data: any = {
      student_id: studentId,
      school_name: dto.school_name,
      location: dto.location,
      class_studied_from: dto.class_studied_from,
      class_studied_to: dto.class_studied_to,
      reason_for_leaving: dto.reason_for_leaving,
    };
    if (dto.id) {
      return this.prisma.student_previous_schools.update({ where: { id: dto.id }, data });
    }
    return this.prisma.student_previous_schools.create({ data });
  }

  async deletePreviousSchool(id: number) {
    return this.prisma.student_previous_schools.delete({ where: { id } }).catch(() => null);
  }

  async upsertALevelDetails(studentCc: number, dto: any) {
    return this.prisma.student_alevel_details.upsert({
      where: { student_id: studentCc },
      update: {
        details: {
          ...dto,
          preferred_subjects_group_a: dto.preferred_subjects_group_a,
          preferred_subjects_group_b: dto.preferred_subjects_group_b,
          olevel_result_counts: dto.olevel_result_counts,
          olevel_subjects_details: dto.olevel_subjects_details,
        },
      },
      create: {
        student_id: studentCc,
        details: {
          ...dto,
          preferred_subjects_group_a: dto.preferred_subjects_group_a,
          preferred_subjects_group_b: dto.preferred_subjects_group_b,
          olevel_result_counts: dto.olevel_result_counts,
          olevel_subjects_details: dto.olevel_subjects_details,
        },
      },
    });
  }

  async hardDeleteStudent(cc: number) {
    // 1. Verify student exists
    const student = await this.prisma.students.findUnique({
      where: { cc },
      select: { cc: true, full_name: true }
    });
    if (!student) throw new NotFoundException(`Student with CC ${cc} not found`);

    // 2. Comprehensive Transactional Wipe
    return this.prisma.$transaction(async (tx) => {
      // A. Clear Financial Linked Tables (Order: Allocations -> Heads -> Vouchers/Fees/Deposits)
      // These tables don't have student_id directly, so we use subqueries or relation filters
      
      // Delete deposit allocations linked to student's records
      await tx.deposit_allocations.deleteMany({
        where: {
          OR: [
            { deposits: { student_id: cc } },
            { student_fees: { student_id: cc } },
            { vouchers: { student_id: cc } }
          ]
        }
      });

      // Delete voucher heads linked to student's records
      await tx.voucher_heads.deleteMany({
        where: {
          OR: [
            { vouchers: { student_id: cc } },
            { student_fees: { student_id: cc } }
          ]
        }
      });

      // B. Clear Secondary Financial Tables
      await tx.vouchers.deleteMany({ where: { student_id: cc } });
      await tx.deposits.deleteMany({ where: { student_id: cc } });

      // C. Clear Academic & Identity Sub-tables
      await tx.student_activities.deleteMany({ where: { student_id: cc } });
      await tx.student_admissions.deleteMany({ where: { student_id: cc } });
      await tx.student_guardians.deleteMany({ where: { student_id: cc } });
      await tx.student_languages.deleteMany({ where: { student_id: cc } });
      await tx.student_previous_schools.deleteMany({ where: { student_id: cc } });
      await tx.relatives_attending_tafs.deleteMany({ where: { student_id: cc } });

      // D. Final Punch: Delete the Student
      // This will cascade delete: student_flags, student_fees, student_fee_bundles
      await tx.students.delete({ where: { cc } });

      return { success: true, message: `Student ${student.full_name} (${cc}) permanently deleted.` };
    });
  }
}
