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
  constructor(private readonly prisma: PrismaService) {}

  // ── List (paginated + search) ─────────────────────────────────────────────

  async listFamilies(query: QueryFamiliesDto) {
    const { page = 1, limit = 10, search } = query;
    const offset = calculateOffset(page, limit);

    const where = {
      deleted_at: null,
      ...(search
        ? {
            OR: [
              { household_name: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search, mode: 'insensitive' as const } },
              { username: { contains: search, mode: 'insensitive' as const } },
              { legacy_pid: { contains: search, mode: 'insensitive' as const } },
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
          username: true,
          primary_address: true,
          consent_publicity: true,
          legacy_pid: true,
          created_at: true,
          _count: { select: { students: { where: { deleted_at: null } } } },
        },
      }),
      this.prisma.families.count({ where }),
    ]);

    return {
      families: families.map((f) => ({
        ...f,
        student_count: f._count.students,
        _count: undefined,
      })),
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
            id: true,
            first_name: true,
            last_name: true,
            cc_number: true,
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
    const studentIds = family.students.map((s) => s.id);
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
    if (dto.username) {
      const conflict = await this.prisma.families.findFirst({
        where: { username: dto.username, deleted_at: null },
      });
      if (conflict) {
        throw new ConflictException(`Username '${dto.username}' is already taken`);
      }
    }

    const password_hash = dto.password
      ? await bcrypt.hash(dto.password, 10)
      : null;

    const family = await this.prisma.families.create({
      data: {
        household_name: dto.household_name,
        primary_address: dto.primary_address,
        email: dto.email,
        username: dto.username,
        password_hash,
        consent_publicity: dto.consent_publicity ?? false,
        legacy_pid: dto.legacy_pid,
      },
      select: {
        id: true,
        household_name: true,
        email: true,
        username: true,
        primary_address: true,
        consent_publicity: true,
        legacy_pid: true,
        created_at: true,
      },
    });

    return family;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async updateFamily(id: number, dto: UpdateFamilyDto) {
    await this._assertExists(id);

    if (dto.username) {
      const conflict = await this.prisma.families.findFirst({
        where: { username: dto.username, deleted_at: null, NOT: { id } },
      });
      if (conflict) {
        throw new ConflictException(`Username '${dto.username}' is already taken`);
      }
    }

    const password_hash = dto.password
      ? await bcrypt.hash(dto.password, 10)
      : undefined;

    const updated = await this.prisma.families.update({
      where: { id },
      data: {
        ...(dto.household_name !== undefined && { household_name: dto.household_name }),
        ...(dto.primary_address !== undefined && { primary_address: dto.primary_address }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.username !== undefined && { username: dto.username }),
        ...(password_hash !== undefined && { password_hash }),
        ...(dto.consent_publicity !== undefined && { consent_publicity: dto.consent_publicity }),
        ...(dto.legacy_pid !== undefined && { legacy_pid: dto.legacy_pid }),
      },
      select: {
        id: true,
        household_name: true,
        email: true,
        username: true,
        primary_address: true,
        consent_publicity: true,
        legacy_pid: true,
        created_at: true,
      },
    });

    return updated;
  }

  // ── Assign child to family ────────────────────────────────────────────────

  async assignChildToFamily(familyId: number, studentId: number) {
    await this._assertExists(familyId);

    const student = await this.prisma.students.findFirst({
      where: { id: studentId, deleted_at: null },
    });
    if (!student) throw new NotFoundException(`Student #${studentId} not found`);

    if (student.family_id === familyId) {
      throw new ConflictException(`Student #${studentId} is already in family #${familyId}`);
    }

    const updated = await this.prisma.students.update({
      where: { id: studentId },
      data: { family_id: familyId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        cc_number: true,
        family_id: true,
      },
    });

    return updated;
  }

  // ── Remove child from family ──────────────────────────────────────────────

  async removeChildFromFamily(familyId: number, studentId: number) {
    await this._assertExists(familyId);

    const student = await this.prisma.students.findFirst({
      where: { id: studentId, deleted_at: null, family_id: familyId },
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
