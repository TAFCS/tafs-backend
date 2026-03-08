import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../../prisma/prisma.service';
import { QueryFamiliesDto } from './dto/query-families.dto';
import { CreateFamilyDto } from './dto/create-family.dto';
import { UpdateFamilyDto } from './dto/update-family.dto';
import { calculateOffset } from '../../utils/pagination.util';
import { createPaginationMeta } from '../../utils/serializer.util';

@Injectable()
export class FamiliesService {
  constructor(private readonly prisma: PrismaService) { }

  // ── List (paginated + search) ─────────────────────────────────────────────

  async listFamilies(query: QueryFamiliesDto) {
    const { page = 1, limit = 10, search } = query;
    const offset = calculateOffset(page, limit);

    const isNumeric = search && /^\d+$/.test(search);
    const where = {
      deleted_at: null,
      ...(search
        ? {
          OR: [
            { household_name: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { legacy_pid: { contains: search, mode: 'insensitive' as const } },
            ...(isNumeric ? [{ id: Number(search) }] : []),
            // Search by guardian CNIC  →  families → students → student_guardians → guardians
            {
              students: {
                some: {
                  deleted_at: null,
                  student_guardians: {
                    some: {
                      guardians: {
                        cnic: { contains: search, mode: 'insensitive' as const },
                      },
                    },
                  },
                },
              },
            },
          ],
        }
        : {}),
    };

    const [families, total] = await this.prisma.$transaction([
      this.prisma.families.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: offset,
        take: limit,
        select: {
          id: true,
          household_name: true,
          email: true,
          primary_address: true,
          legacy_pid: true,
          created_at: true,
          students: {
            where: { deleted_at: null },
            take: 1,
            select: {
              student_guardians: {
                where: { is_primary_contact: true },
                take: 1,
                select: {
                  guardians: {
                    select: {
                      full_name: true,
                      cnic: true,
                    }
                  }
                }
              }
            }
          }
        },
      }),
      this.prisma.families.count({ where }),
    ]);

    return {
      families: families.map((f) => {
        const primaryGuardian = f.students?.[0]?.student_guardians?.[0]?.guardians;
        return {
          ...f,
          primary_guardian: primaryGuardian ? {
            name: primaryGuardian.full_name,
            cnic: primaryGuardian.cnic,
          } : null,
          student_count: null,
        };
      }),
      meta: createPaginationMeta(page, limit, total),
    };
  }

  // ── Get one (with students + guardians) ───────────────────────────────────

  async getFamilyById(id: number) {
    const family = await this.prisma.families.findFirst({
      where: { id, deleted_at: null },
      include: {
        students: {
          where: { deleted_at: null },
          select: {
            cc: true,
            full_name: true,
            gr_number: true,
            status: true,
            photograph_url: true,
            campuses: { select: { campus_name: true, campus_code: true } },
          },
        },
        student_siblings: true,
      },
    });

    if (!family) throw new NotFoundException(`Family #${id} not found`);

    // Collect guardian info via student_guardians junction
    const studentIds = family.students.map((s) => s.cc);
    const guardians =
      studentIds.length > 0
        ? await this.prisma.student_guardians.findMany({
          where: { student_id: { in: studentIds } },
          distinct: ['guardian_id'],
          include: {
            guardians: {
              select: {
                id: true,
                full_name: true,
                primary_phone: true,
                email_address: true,
                cnic: true,
                occupation: true,
              },
            },
          },
        })
        : [];

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password_hash, ...safeFamily } = family;
    return {
      ...safeFamily,
      guardians: guardians.map((sg) => ({ ...sg.guardians, relationship: sg.relationship })),
    };
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createFamily(dto: CreateFamilyDto) {
    const password_hash = dto.password
      ? await bcrypt.hash(dto.password, 10)
      : null;

    const family = await this.prisma.families.create({
      data: {
        household_name: dto.household_name,
        primary_address: dto.primary_address,
        email: dto.email,
        password_hash,
        legacy_pid: dto.legacy_pid,
      },
      select: {
        id: true,
        household_name: true,
        email: true,
        primary_address: true,
        legacy_pid: true,
        created_at: true,
      },
    });

    return family;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async updateFamily(id: number, dto: UpdateFamilyDto) {
    await this._assertExists(id);

    const password_hash = dto.password
      ? await bcrypt.hash(dto.password, 10)
      : undefined;

    const updated = await this.prisma.families.update({
      where: { id },
      data: {
        ...(dto.household_name !== undefined && { household_name: dto.household_name }),
        ...(dto.primary_address !== undefined && { primary_address: dto.primary_address }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(password_hash !== undefined && { password_hash }),
        ...(dto.legacy_pid !== undefined && { legacy_pid: dto.legacy_pid }),
      },
      select: {
        id: true,
        household_name: true,
        email: true,
        primary_address: true,
        legacy_pid: true,
        created_at: true,
      },
    });

    return updated;
  }

  // ── Assign child to family ────────────────────────────────────────────────

  async assignChildToFamily(familyId: number, studentId: number) {
    const [family, student] = await Promise.all([
      this.prisma.families.findFirst({
        where: { id: familyId, deleted_at: null },
        include: { students: { where: { deleted_at: null }, take: 1 } },
      }),
      this.prisma.students.findFirst({
        where: { cc: studentId, deleted_at: null },
      }),
    ]);

    if (!family) throw new NotFoundException(`Family #${familyId} not found`);
    if (!student) throw new NotFoundException(`Student #${studentId} not found`);

    if (student.family_id === familyId) {
      throw new ConflictException(
        `Student #${studentId} is already in family #${familyId}`,
      );
    }

    // Identify target guardians to link to (from existing siblings)
    const targetStudentId = family.students?.[0]?.cc;
    const targetGuardians = targetStudentId
      ? await this.prisma.student_guardians.findMany({
        where: { student_id: targetStudentId },
      })
      : [];

    const updated = await this.prisma.$transaction(async (tx) => {
      // 1. Update the student's family link
      const s = await tx.students.update({
        where: { cc: studentId },
        data: { family_id: familyId },
        select: {
          cc: true,
          full_name: true,
          family_id: true,
        },
      });

      // 2. Remove old family guardian links
      await tx.student_guardians.deleteMany({
        where: { student_id: studentId },
      });

      // 3. Link to new family's guardians
      if (targetGuardians.length > 0) {
        await tx.student_guardians.createMany({
          data: targetGuardians.map((tg) => ({
            student_id: studentId,
            guardian_id: tg.guardian_id,
            relationship: tg.relationship,
            is_primary_contact: tg.is_primary_contact,
            is_emergency_contact: tg.is_emergency_contact,
          })),
        });
      }

      return s;
    });

    return updated;
  }

  // ── Remove child from family ──────────────────────────────────────────────

  async removeChildFromFamily(familyId: number, studentId: number) {
    await this._assertExists(familyId);

    const student = await this.prisma.students.findFirst({
      where: { cc: studentId, deleted_at: null, family_id: familyId },
    });
    if (!student) {
      throw new NotFoundException(
        `Student #${studentId} not found in family #${familyId}`,
      );
    }

    // family_id is a required non-nullable FK — we cannot null it out.
    // Instead we prevent accidental removal without a destination.
    throw new BadRequestException(
      'Use the assign endpoint to move the student to another family first.',
    );
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async _assertExists(id: number) {
    const family = await this.prisma.families.findFirst({
      where: { id, deleted_at: null },
    });
    if (!family) throw new NotFoundException(`Family #${id} not found`);
    return family;
  }
}
