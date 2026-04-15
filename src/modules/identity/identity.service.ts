import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  CreateAdmissionDto,
  GuardianDto,
} from './dto/create-admission.dto';
import { StudentFlagsService } from '../student-flags/student-flags.service';
import { SubmitAdmissionFormDto } from './dto/submit-admission-form.dto';

type TxClient = Prisma.TransactionClient;

@Injectable()
export class IdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flagsSvc: StudentFlagsService,
  ) { }

  async registerAdmission(dto: CreateAdmissionDto) {
    return this.prisma.$transaction(async (tx) => {
      // ── 1. Resolve or create family ──────────────────────────────────────
      let familyId: number;

      if (dto.existing_family_id) {
        const existing = await tx.families.findUnique({
          where: { id: dto.existing_family_id },
        });
        if (!existing || existing.deleted_at) {
          throw new NotFoundException(
            `Family #${dto.existing_family_id} not found`,
          );
        }
        familyId = existing.id;
      } else {
        // Try to resolve family by Father's or Mother's CNIC
        let resolvedFamilyId: number | null = null;

        if (dto.father.cnic) {
          const existingGuardian = await tx.guardians.findFirst({
            where: { cnic: dto.father.cnic },
            include: {
              student_guardians: {
                include: {
                  students: true,
                },
              },
            },
          });
          const family = existingGuardian?.student_guardians[0]?.students?.family_id;
          if (family) resolvedFamilyId = family;
        }

        if (!resolvedFamilyId && dto.mother.cnic) {
          const existingGuardian = await tx.guardians.findFirst({
            where: { cnic: dto.mother.cnic },
            include: {
              student_guardians: {
                include: {
                  students: true,
                },
              },
            },
          });
          const family = existingGuardian?.student_guardians[0]?.students?.family_id;
          if (family) resolvedFamilyId = family;
        }

        if (resolvedFamilyId) {
          familyId = resolvedFamilyId;
          // Update home_phone if provided
          if (dto.home_phone) {
            await tx.families.update({
              where: { id: familyId },
              data: { home_phone: dto.home_phone },
            });
          }
        } else {
          const familyName = dto.father.full_name
            ? dto.father.full_name
            : dto.full_name;

          const family = await tx.families.create({
            data: {
              household_name: familyName,
              primary_address: [dto.father.house_appt_name, dto.father.area_block].filter(Boolean).join(', ') || null,
              home_phone: dto.home_phone || null,
            },
          });
          familyId = family.id;
        }
      }

      // ── 2. Create student ────────────────────────────────────────────────
      const dob = new Date(dto.dob);

      // Manual increment of CC (Computer Code) to avoid sequence desync issues
      const latestStudent = await tx.students.findFirst({
        orderBy: { cc: 'desc' },
        select: { cc: true },
      });
      const nextCC = (latestStudent?.cc || 0) + 1;

      const student = await tx.students.create({
        data: {
          cc: nextCC,
          gr_number: dto.gr_number,
          family_id: familyId,
          full_name: dto.full_name,
          dob,
          gender: dto.gender,
          nationality: dto.nationality,
          religion: dto.religion,
          country: dto.country,
          province: dto.province,
          city: dto.city,
          identification_marks: dto.identification_marks,
          medical_info: dto.medical_info,
          primary_phone_country_code: dto.primary_phone_country_code ?? '+92',
          primary_phone: dto.primary_phone,
          whatsapp_country_code: dto.whatsapp_country_code ?? '+92',
          whatsapp_number: dto.whatsapp_number,
          email: dto.email,
          academic_year: dto.admission.academic_year,
          admission_age_years: this.calcAge(dob),
          status: 'SOFT_ADMISSION',
          campus_id: dto.admission.campus_id || undefined,
          class_id: dto.admission.class_id || undefined,
          section_id: dto.admission.section_id || undefined,
        },
      });

      // ── 3. Upsert father ─────────────────────────────────────────────────
      const father = await this.upsertGuardian(tx, dto.father);
      await tx.student_guardians.create({
        data: {
          student_id: student.cc,
          guardian_id: father.id,
          relationship: 'Father',
          is_primary_contact: true,
          is_emergency_contact: false,
        },
      });

      // ── 4. Upsert mother ─────────────────────────────────────────────────
      const mother = await this.upsertGuardian(tx, dto.mother);
      if (mother.id !== father.id) {
        await tx.student_guardians.create({
          data: {
            student_id: student.cc,
            guardian_id: mother.id,
            relationship: 'Mother',
            is_primary_contact: false,
            is_emergency_contact: false,
          },
        });
      }

      // ── 5. Emergency contact ─────────────────────────────────────────────
      if (dto.emergency_contact) {
        const ec = dto.emergency_contact;

        const isFather =
          father.full_name === ec.full_name &&
          father.primary_phone === ec.primary_phone;
        const isMother =
          mother.full_name === ec.full_name &&
          mother.primary_phone === ec.primary_phone;

        if (isFather) {
          await tx.student_guardians.update({
            where: {
              student_id_guardian_id: {
                student_id: student.cc,
                guardian_id: father.id,
              },
            },
            data: { is_emergency_contact: true },
          });
        } else if (isMother) {
          await tx.student_guardians.update({
            where: {
              student_id_guardian_id: {
                student_id: student.cc,
                guardian_id: mother.id,
              },
            },
            data: { is_emergency_contact: true },
          });
        } else {
          const ecGuardian = await tx.guardians.create({
            data: {
              full_name: ec.full_name,
              primary_phone_country_code: ec.primary_phone_country_code ?? '+92',
              primary_phone: ec.primary_phone,
            } as any,
          });
          await tx.student_guardians.create({
            data: {
              student_id: student.cc,
              guardian_id: ecGuardian.id,
              relationship: ec.relationship,
              is_primary_contact: false,
              is_emergency_contact: true,
            },
          });
        }
      }

      // ── 6. Previous schools ──────────────────────────────────────────────
      if (dto.previous_schools?.length) {
        await tx.student_previous_schools.createMany({
          data: dto.previous_schools.map((school) => ({
            student_id: student.cc,
            school_name: school.school_name,
            location: school.location,
            class_studied_from: school.class_studied_from,
            class_studied_to: school.class_studied_to,
            reason_for_leaving: school.reason_for_leaving,
          })),
        });
      }

      // ── 7. Admission record ──────────────────────────────────────────────
      const resolvedGrade = await this.resolveGradeCode(tx, dto.admission.requested_grade);
      await tx.student_admissions.create({
        data: {
          student_id: student.cc,
          academic_system: dto.admission.academic_system,
          requested_grade: resolvedGrade,
          academic_year: new Date().getFullYear().toString(),
          discipline: dto.admission.discipline,
        },
      });

      // ── 8. Handle Flag (Universal) ──────────────────────────────────────
      if (dto.is_flagged) {
        await this.flagsSvc.addFlag(
          student.cc,
          dto.flag_description || 'Universal FLAG',
          dto.flag_reminder_date ? new Date(dto.flag_reminder_date) : undefined
        );
      }

      // ── 9. Return full record ────────────────────────────────────────────
      return tx.students.findUnique({
        where: { cc: student.cc },
        include: this.defaultStudentInclude(),
      });
    },
      {
        maxWait: 5000,
        timeout: 15000,
      });
  }

  async submitAdmissionForm(dto: SubmitAdmissionFormDto) {
    return this.prisma.$transaction(
      async (tx) => {
        // 1. Find existing student
        const student = await tx.students.findUnique({
          where: { cc: dto.cc },
        });

        if (!student) {
          throw new NotFoundException(`Student with CC ${dto.cc} not found`);
        }

        // 2. Update Student base table
        await tx.students.update({
          where: { cc: student.cc },
          data: {
            gr_number: dto.gr_number || undefined,
            gender: dto.gender || undefined,
            religion: dto.religion || undefined,
            nationality: dto.nationality || undefined,
            identification_marks: dto.identification_marks || undefined,
            physical_impairment: dto.physical_impairment || undefined,
            medical_info: dto.medical_info || undefined,
            interests: dto.interests || undefined,
            academic_year: dto.admission?.academic_year || undefined,
            status: 'ENROLLED',
          },
        });

        // 3. Upsert Guardians if provided
        let fatherId: number | null = null;
        let motherId: number | null = null;

        if (dto.father) {
          const f = await this.upsertGuardian(tx, dto.father);
          fatherId = f.id;
          await tx.student_guardians.upsert({
            where: { student_id_guardian_id: { student_id: student.cc, guardian_id: f.id } },
            create: { student_id: student.cc, guardian_id: f.id, relationship: 'Father', is_primary_contact: true },
            update: { relationship: 'Father', is_primary_contact: true },
          });
        }

        if (dto.mother) {
          const m = await this.upsertGuardian(tx, dto.mother);
          motherId = m.id;
          if (motherId !== fatherId) {
            await tx.student_guardians.upsert({
              where: { student_id_guardian_id: { student_id: student.cc, guardian_id: m.id } },
              create: { student_id: student.cc, guardian_id: m.id, relationship: 'Mother' },
              update: { relationship: 'Mother' },
            });
          }
        }

        if (dto.guardian) {
          const g = await this.upsertGuardian(tx, dto.guardian);
          if (g.id !== fatherId && g.id !== motherId) {
            await tx.student_guardians.upsert({
              where: { student_id_guardian_id: { student_id: student.cc, guardian_id: g.id } },
              create: { student_id: student.cc, guardian_id: g.id, relationship: 'Guardian', is_emergency_contact: true },
              update: { is_emergency_contact: true },
            });
          }
        }

        // 4. Update Admission details
        if (dto.admission) {
          const existingAdm = await tx.student_admissions.findFirst({
            where: { student_id: student.cc },
          });
          if (existingAdm) {
            const resolvedGrade = await this.resolveGradeCode(tx, dto.admission.requested_grade);
            await tx.student_admissions.update({
              where: { id: existingAdm.id },
              data: {
                academic_system: dto.admission.academic_system,
                requested_grade: resolvedGrade,
                academic_year: new Date().getFullYear().toString(),
                discipline: dto.admission.discipline,
              },
            });
          } else {
            const resolvedGrade = await this.resolveGradeCode(tx, dto.admission.requested_grade);
            await tx.student_admissions.create({
              data: {
                student_id: student.cc,
                academic_system: dto.admission.academic_system,
                requested_grade: resolvedGrade,
                academic_year: new Date().getFullYear().toString(),
                discipline: dto.admission.discipline,
              },
            });
          }
        }

        // 5. Replace Previous Schools
        if (dto.previous_schools) {
          await tx.student_previous_schools.deleteMany({ where: { student_id: student.cc } });
          if (dto.previous_schools.length > 0) {
            await tx.student_previous_schools.createMany({
              data: dto.previous_schools.map((s) => ({
                student_id: student.cc,
                school_name: s.school_name,
                location: s.location,
                class_studied_from: s.class_studied_from,
                class_studied_to: s.class_studied_to,
                reason_for_leaving: s.reason_for_leaving,
              })),
            });
          }
        }

        // 6. Replace Languages
        if (dto.languages) {
          await tx.student_languages.deleteMany({ where: { student_id: student.cc } });
          if (dto.languages.length > 0) {
            await tx.student_languages.createMany({
              data: dto.languages.map((l) => ({
                student_id: student.cc,
                language_name: l.language_name,
                can_speak: l.can_speak,
                can_read: l.can_read,
                can_write: l.can_write,
              })),
            });
          }
        }

        // 7. Siblings
        if (dto.siblings) {
          // Find old siblings with this family ID to avoid duplicates?
          // We'll just append them for now or recreate them if we know which are new
          // But siblings are tied to Family, not Student.
          // Since Family ID is known:
          const existingSiblings = await tx.student_siblings.findMany({
            where: { family_id: student.family_id }
          });
          const existingNames = new Set(
            existingSiblings
              .filter(s => s.full_name)
              .map(s => s.full_name!.toLowerCase())
          );

          for (const sib of dto.siblings) {
            if (!existingNames.has(sib.full_name.toLowerCase())) {
              await tx.student_siblings.create({
                data: {
                  family_id: student.family_id,
                  full_name: sib.full_name,
                  relationship: sib.relationship,
                  age: sib.age ? Number(sib.age) : null,
                  current_school: sib.current_school,
                  pick_and_drop: sib.pick_and_drop,
                }
              });
            }
          }
        }

        // 8. Relatives
        if (dto.relatives) {
          await tx.relatives_attending_tafs.deleteMany({ where: { student_id: student.cc } });
          if (dto.relatives.length > 0) {
            await tx.relatives_attending_tafs.createMany({
              data: dto.relatives.map((r) => ({
                student_id: student.cc,
                name: r.name,
                class: r.class,
                relationship: r.relationship,
              }))
            });
          }
        }

        // 9. Activities
        if (dto.activities) {
          await tx.student_activities.deleteMany({ where: { student_id: student.cc } });
          if (dto.activities.length > 0) {
            await tx.student_activities.createMany({
              data: dto.activities.map((a) => ({
                student_id: student.cc,
                activity_name: a.activity_name,
                grade: a.grade,
                honors_awards: a.honors_awards,
                continue_at_tafs: a.continue_at_tafs,
              }))
            });
          }
        }

        // Return updated student
        return tx.students.findUnique({
          where: { cc: student.cc },
          include: this.defaultStudentInclude(),
        });
      },
      {
        maxWait: 5000,
        timeout: 20000,
      }
    );
  }

  async getAdmissionByCC(cc: number) {
    if (!cc) {
      throw new NotFoundException('Admission not found for empty CC');
    }

    const student = await this.prisma.students.findFirst({
      where: {
        cc: cc,
      },
      include: this.defaultStudentInclude(),
    });

    if (!student) {
      throw new NotFoundException(`Admission with CC ${cc} not found`);
    }

    return student;
  }

  async getGuardianByCnic(cnic: string) {
    if (!cnic) {
      throw new NotFoundException('CNIC is required');
    }

    const guardian = await this.prisma.guardians.findUnique({
      where: { cnic: cnic.trim() },
    });

    if (!guardian) {
      throw new NotFoundException(`Guardian with CNIC ${cnic} not found`);
    }

    return guardian;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private defaultStudentInclude(): Prisma.studentsInclude {
    return {
      families: {
        include: {
          students: {
            where: { deleted_at: null },
            select: {
              cc: true,
              full_name: true,
              status: true,
              student_admissions: {
                select: { requested_grade: true },
              },
              student_guardians: {
                where: { relationship: 'Father' },
                include: { guardians: { select: { full_name: true } } },
              },
            },
          },
        },
      },
      student_admissions: true,
      student_previous_schools: true,
      student_guardians: {
        include: { guardians: true },
      },
    };
  }

  /**
   * Upsert a guardian by CNIC if provided, otherwise always create.
   * This ensures siblings share the same guardian records.
   */
  private async upsertGuardian(tx: TxClient, data: GuardianDto) {
    const guardianFullName = data.full_name?.trim();
    if (!guardianFullName) throw new BadRequestException('Guardian full_name is required');

    const payload = {
      full_name: guardianFullName,
      primary_phone_country_code: data.primary_phone_country_code ?? '+92',
      primary_phone: data.primary_phone ?? null,
      whatsapp_country_code: data.whatsapp_country_code ?? '+92',
      whatsapp_number: data.whatsapp_number ?? null,
      work_phone_country_code: data.work_phone_country_code ?? '+92',
      work_phone: data.work_phone ?? null,
      email_address: data.email_address ?? null,
      dob: data.dob ? new Date(data.dob) : null,
      education_level: data.education_level ?? null,
      occupation: data.occupation ?? null,
      organization: data.organization ?? null,
      job_position: data.job_position ?? null,
      occupational_position: data.occupational_position ?? null,
      house_appt_name: data.house_appt_name ?? null,
      house_appt_number: data.house_appt_number ?? null,
      area_block: data.area_block ?? null,
      city: data.city ?? null,
      province: data.province ?? null,
      country: data.country ?? null,
      postal_code: data.postal_code ?? null,
      fax_number: data.fax_number ?? null,
    };

    if (data.cnic) {
      return tx.guardians.upsert({
        where: { cnic: data.cnic },
        create: { cnic: data.cnic, ...payload },
        update: payload,
      });
    }

    return tx.guardians.create({ data: payload as any });
  }

  /**
   * Resolves a grade string (either a code or description) to a standard class_code.
   * If no match is found, it returns the original string.
   */
  private async resolveGradeCode(tx: TxClient, grade: string): Promise<string> {
    if (!grade) return 'N/A';

    // Try to find a class where the class_code or description matches
    const matched = await tx.classes.findFirst({
      where: {
        OR: [
          { class_code: { equals: grade, mode: 'insensitive' } },
          { description: { equals: grade, mode: 'insensitive' } },
        ],
      },
      select: { class_code: true },
    });

    return matched?.class_code || grade;
  }

  /**
   * Calculate age in years from a date of birth.
   */
  private calcAge(dob: Date): number {
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
    return age;
  }
}
