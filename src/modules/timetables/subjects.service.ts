import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  CreateSubjectDto,
  ListSubjectsQueryDto,
  UpdateSubjectDto,
} from './dto/timetables.dto';

@Injectable()
export class SubjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListSubjectsQueryDto) {
    const where: Prisma.subjectsWhereInput = {};
    if (query.academic_system) {
      where.academic_system = query.academic_system;
    }
    if (query.active !== undefined) {
      where.is_active = query.active;
    }
    return this.prisma.subjects.findMany({
      where,
      orderBy: [{ name: 'asc' }],
    });
  }

  async create(dto: CreateSubjectDto) {
    const name = dto.name.trim().toUpperCase();
    try {
      return await this.prisma.subjects.create({
        data: {
          name,
          code: dto.code?.trim() || null,
          academic_system: dto.academic_system?.trim() || 'A-Level',
          is_active: true,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'A subject with this name already exists for this academic system',
        );
      }
      throw e;
    }
  }

  async update(id: number, dto: UpdateSubjectDto) {
    const existing = await this.prisma.subjects.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Subject not found');

    try {
      return await this.prisma.subjects.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim().toUpperCase() } : {}),
          ...(dto.code !== undefined ? { code: dto.code?.trim() || null } : {}),
          ...(dto.academic_system !== undefined
            ? { academic_system: dto.academic_system?.trim() || null }
            : {}),
          ...(dto.is_active !== undefined ? { is_active: dto.is_active } : {}),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'A subject with this name already exists for this academic system',
        );
      }
      throw e;
    }
  }

  async remove(id: number) {
    const existing = await this.prisma.subjects.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Subject not found');

    const slotCount = await this.prisma.timetable_slots.count({
      where: { subject_id: id },
    });

    if (slotCount > 0) {
      return this.prisma.subjects.update({
        where: { id },
        data: { is_active: false },
      });
    }

    return this.prisma.subjects.delete({ where: { id } });
  }
}
