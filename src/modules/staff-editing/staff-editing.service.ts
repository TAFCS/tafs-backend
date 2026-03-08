import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { GetSheetStudentsDto } from './dto/get-sheet-students.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { CreateGuardianDto } from './dto/create-guardian.dto';
import { UpdateGuardianDto } from './dto/update-guardian.dto';
import { UpdateGuardianRelationshipDto } from './dto/update-guardian-relationship.dto';
import { calculateOffset } from '../../utils/pagination.util';
import { createPaginationMeta } from '../../utils/serializer.util';

@Injectable()
export class StaffEditingService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Students ─────────────────────────────────────────────────────────────

  async getStudents(dto: GetSheetStudentsDto) {
    const { page = 1, limit = 50, search, campus_id, class_id, section_id } = dto;
    const offset = calculateOffset(page, limit);

    const where: Prisma.studentsWhereInput = { deleted_at: null };

    if (search) {
      where.OR = [
        { full_name: { contains: search, mode: 'insensitive' } },
        { gr_number: { contains: search, mode: 'insensitive' } },
        ...(/^\d+$/.test(search) ? [{ cc: Number(search) }] : []),
      ];
    }

    if (campus_id) where.campus_id = campus_id;
    if (class_id) where.class_id = class_id;
    if (section_id) where.section_id = section_id;

    const [total, rows] = await Promise.all([
      this.prisma.students.count({ where }),
      this.prisma.students.findMany({
        where,
        skip: offset,
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
          primary_phone: true,
          email: true,
          campus_id: true,
          class_id: true,
          section_id: true,
          house_id: true,
          admission_age_years: true,
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
          sections: { select: { description: true } },
          houses: { select: { house_name: true } },
          student_admissions: {
            orderBy: { application_date: 'desc' },
            take: 1,
            select: {
              requested_grade: true,
              academic_system: true,
              academic_year: true,
            },
          },
        },
      }),
    ]);

    const items = rows.map((s) => this.flattenStudent(s));
    const meta = createPaginationMeta(page, limit, total);

    return { items, meta };
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
    const { dob, ...rest } = dto;
    const data: Record<string, unknown> = {
      ...rest,
      ...(dob !== undefined ? { dob: new Date(dob) } : {}),
    };

    try {
      await this.prisma.students.update({ where: { cc }, data: data as any });
    } catch (e: any) {
      if (e?.code === 'P2025') throw new NotFoundException(`Student #${cc} not found`);
      throw e;
    }

    // Return the updated spreadsheet row — guardian tree excluded for auto-save speed
    return this.fetchStudentRow(cc);
  }

  // Lightweight re-fetch for auto-save responses (no guardian tree loaded)
  private async fetchStudentRow(cc: number) {
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
    }));
  }

  async addGuardianToStudent(studentCc: number, dto: CreateGuardianDto) {
    await this.assertStudentExists(studentCc);

    const { relationship, is_primary_contact = false, is_emergency_contact = false, ...guardianFields } = dto;

    // Convert dob string to Date if present
    const guardianData: any = { ...guardianFields };
    if (guardianFields.dob) guardianData.dob = new Date(guardianFields.dob);

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
    };
  }

  async getGuardian(id: number) {
    const guardian = await this.prisma.guardians.findUnique({ where: { id } });
    if (!guardian) throw new NotFoundException(`Guardian #${id} not found`);
    return guardian;
  }

  async updateGuardian(id: number, dto: UpdateGuardianDto) {
    const { dob, ...rest } = dto;
    const data: Record<string, unknown> = {
      ...rest,
      ...(dob !== undefined ? { dob: new Date(dob) } : {}),
    };

    try {
      return await this.prisma.guardians.update({ where: { id }, data: data as any });
    } catch (e: any) {
      if (e?.code === 'P2025') throw new NotFoundException(`Guardian #${id} not found`);
      throw e;
    }
  }

  async updateGuardianRelationship(
    studentCc: number,
    guardianId: number,
    dto: UpdateGuardianRelationshipDto,
  ) {
    try {
      return await this.prisma.student_guardians.update({
        where: {
          student_id_guardian_id: {
            student_id: studentCc,
            guardian_id: guardianId,
          },
        },
        data: dto,
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
      primary_phone: s.primary_phone,
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
      place_of_birth: s.place_of_birth,
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
      academic_year: admission?.academic_year ?? null,
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
      primary_phone: s.primary_phone,
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
      place_of_birth: s.place_of_birth,
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
      academic_year: admission?.academic_year ?? null,
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
