import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  CreateAdmissionDto,
  GuardianDto,
} from './dto/create-admission.dto';

type TxClient = Prisma.TransactionClient;

@Injectable()
export class IdentityService {
  constructor(private readonly prisma: PrismaService) { }

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
        const family = await tx.families.create({
          data: {
            household_name: dto.father.full_name,
          },
        });
        familyId = family.id;
      }

      // ── 2. Generate Computer Code ────────────────────────────────────────
      const ccNumber = await this.generateCCNumber(tx);

      // ── 3. Create student ────────────────────────────────────────────────
      const dob = new Date(dto.dob);
      const student = await tx.students.create({
        data: {
          family_id: familyId,
          cc_number: ccNumber,
          first_name: dto.first_name,
          last_name: dto.last_name,
          dob,
          gender: dto.gender,
          nationality: dto.nationality,
          religion: dto.religion,
          place_of_birth: dto.place_of_birth,
          identification_marks: dto.identification_marks,
          medical_info: dto.medical_info,
          consent_publicity: dto.consent_publicity ?? false,
          primary_phone: dto.primary_phone,
          whatsapp_number: dto.whatsapp_number,
          email: dto.email,
          admission_age_years: this.calcAge(dob),
          status: 'SOFT_ADMISSION',
        },
      });

      // ── 4. Upsert father ─────────────────────────────────────────────────
      const father = await this.upsertGuardian(tx, dto.father);
      await tx.student_guardians.create({
        data: {
          student_id: student.id,
          guardian_id: father.id,
          relationship: 'Father',
          is_primary_contact: true,
          is_emergency_contact: false,
        },
      });

      // ── 5. Upsert mother ─────────────────────────────────────────────────
      const mother = await this.upsertGuardian(tx, dto.mother);
      if (mother.id !== father.id) {
        await tx.student_guardians.create({
          data: {
            student_id: student.id,
            guardian_id: mother.id,
            relationship: 'Mother',
            is_primary_contact: false,
            is_emergency_contact: false,
          },
        });
      }

      // ── 6. Emergency contact ─────────────────────────────────────────────
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
                student_id: student.id,
                guardian_id: father.id,
              },
            },
            data: { is_emergency_contact: true },
          });
        } else if (isMother) {
          await tx.student_guardians.update({
            where: {
              student_id_guardian_id: {
                student_id: student.id,
                guardian_id: mother.id,
              },
            },
            data: { is_emergency_contact: true },
          });
        } else {
          const ecGuardian = await tx.guardians.create({
            data: {
              full_name: ec.full_name,
              primary_phone: ec.primary_phone,
            },
          });
          await tx.student_guardians.create({
            data: {
              student_id: student.id,
              guardian_id: ecGuardian.id,
              relationship: ec.relationship,
              is_primary_contact: false,
              is_emergency_contact: true,
            },
          });
        }
      }

      // ── 7. Previous schools ──────────────────────────────────────────────
      if (dto.previous_schools?.length) {
        await tx.student_previous_schools.createMany({
          data: dto.previous_schools.map((school) => ({
            student_id: student.id,
            school_name: school.school_name,
            location: school.location,
            class_studied_from: school.class_studied_from,
            class_studied_to: school.class_studied_to,
            reason_for_leaving: school.reason_for_leaving,
          })),
        });
      }

      // ── 8. Admission record ──────────────────────────────────────────────
      await tx.student_admissions.create({
        data: {
          student_id: student.id,
          academic_system: dto.admission.academic_system,
          requested_grade: dto.admission.requested_grade,
          academic_year: dto.admission.academic_year,
        },
      });

      // ── 9. Return full record ────────────────────────────────────────────
      return tx.students.findUnique({
        where: { id: student.id },
        include: this.defaultStudentInclude(),
      });
    },
      {
        maxWait: 5000,
        timeout: 15000,
      });
  }

  async getAdmissionByCC(cc: string) {
    if (!cc?.trim()) {
      throw new NotFoundException('Admission not found for empty CC');
    }

    const student = await this.prisma.students.findFirst({
      where: {
        cc_number: cc,
      },
      include: this.defaultStudentInclude(),
    });

    if (!student) {
      throw new NotFoundException(`Admission with CC ${cc} not found`);
    }

    return student;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private defaultStudentInclude(): Prisma.studentsInclude {
    return {
      families: true,
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
    const payload = {
      full_name: data.full_name,
      primary_phone: data.primary_phone ?? null,
      whatsapp_number: data.whatsapp_number ?? null,
      work_phone: data.work_phone ?? null,
      email_address: data.email_address ?? null,
      dob: data.dob ? new Date(data.dob) : null,
      place_of_birth: data.place_of_birth ?? null,
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
    };

    if (data.cnic) {
      return tx.guardians.upsert({
        where: { cnic: data.cnic },
        create: { cnic: data.cnic, ...payload },
        update: payload,
      });
    }

    return tx.guardians.create({ data: payload });
  }

  /**
   * Generate the next CC number: CC-YYYY-NNNNN
   * Uses the total student count inside the transaction to be race-safe.
   */
  private async generateCCNumber(tx: TxClient): Promise<string> {
    const year = new Date().getFullYear();

    // Find the highest CC number for the current year
    const lastStudent = await tx.students.findFirst({
      where: { cc_number: { startsWith: `CC-${year}-` } },
      orderBy: { cc_number: 'desc' },
    });

    let nextNumber = 1;
    if (lastStudent && lastStudent.cc_number) {
      const parts = lastStudent.cc_number.split('-');
      if (parts.length === 3) {
        const lastCount = parseInt(parts[2], 10);
        if (!isNaN(lastCount)) {
          nextNumber = lastCount + 1;
        }
      }
    }

    const padded = String(nextNumber).padStart(5, '0');
    return `CC-${year}-${padded}`;
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
