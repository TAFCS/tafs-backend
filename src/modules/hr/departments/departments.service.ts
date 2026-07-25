import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';

export class CreateDepartmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}

export class CreateStaffCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  employee_code_dep?: string;
}

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async findAll() {
    return this.prisma.departments.findMany({
      include: {
        staff_categories: {
          include: { _count: { select: { employee_profiles: true } } },
          orderBy: { name: 'asc' },
        },
        _count: { select: { employee_profiles: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: number) {
    const dept = await this.prisma.departments.findUnique({
      where: { id },
      include: {
        staff_categories: {
          include: { _count: { select: { employee_profiles: true } } },
          orderBy: { name: 'asc' },
        },
        _count: { select: { employee_profiles: true } },
      },
    });
    if (!dept) {
      throw new NotFoundException(`Department with ID ${id} not found`);
    }
    return dept;
  }

  async create(dto: CreateDepartmentDto, changedBy?: string) {
    const existing = await this.prisma.departments.findFirst({
      where: { name: { equals: dto.name, mode: 'insensitive' } },
    });
    if (existing) {
      throw new ConflictException(`Department "${dto.name}" already exists`);
    }

    const record = await this.prisma.departments.create({ data: dto });
    this.auditLogs.log({
      entity_type: 'DEPARTMENT',
      entity_id: String(record.id),
      action: 'CREATED',
      section: 'hr',
      new_value: dto.name,
      changed_by: changedBy ?? 'system',
    });
    return this.findOne(record.id);
  }

  async update(id: number, dto: Partial<CreateDepartmentDto>, changedBy?: string) {
    const existing = await this.findOne(id);
    if (dto.name) {
      const clash = await this.prisma.departments.findFirst({
        where: {
          name: { equals: dto.name, mode: 'insensitive' },
          NOT: { id },
        },
      });
      if (clash) {
        throw new ConflictException(`Department "${dto.name}" already exists`);
      }
    }

    await this.prisma.departments.update({ where: { id }, data: dto });
    this.auditLogs.log({
      entity_type: 'DEPARTMENT',
      entity_id: String(id),
      action: 'UPDATED',
      section: 'hr',
      old_value: existing.name,
      new_value: dto.name ?? existing.name,
      changed_by: changedBy ?? 'system',
    });
    return this.findOne(id);
  }

  async remove(id: number, changedBy?: string) {
    const existing = await this.findOne(id);
    const employeeCount = existing._count.employee_profiles;
    if (employeeCount > 0) {
      throw new ConflictException(
        `Cannot delete department "${existing.name}" — ${employeeCount} employee(s) assigned. Reassign them first.`,
      );
    }

    const categoryWithEmployees = existing.staff_categories.find(
      (c) => c._count.employee_profiles > 0,
    );
    if (categoryWithEmployees) {
      throw new ConflictException(
        `Cannot delete department "${existing.name}" — category "${categoryWithEmployees.name}" still has employees.`,
      );
    }

    const calendarCount = await this.prisma.academic_calendar_days.count({
      where: { department_id: id },
    });
    if (calendarCount > 0) {
      throw new ConflictException(
        `Cannot delete department "${existing.name}" — ${calendarCount} calendar day(s) still reference it.`,
      );
    }

    // Categories with no employees; calendar refs on categories checked below
    const categoryIds = existing.staff_categories.map((c) => c.id);
    if (categoryIds.length > 0) {
      const catCalendar = await this.prisma.academic_calendar_days.count({
        where: { staff_category_id: { in: categoryIds } },
      });
      if (catCalendar > 0) {
        throw new ConflictException(
          `Cannot delete department "${existing.name}" — ${catCalendar} calendar day(s) reference its categories.`,
        );
      }
      await this.prisma.staff_categories.deleteMany({ where: { department_id: id } });
    }

    const record = await this.prisma.departments.delete({ where: { id } });
    this.auditLogs.log({
      entity_type: 'DEPARTMENT',
      entity_id: String(id),
      action: 'DELETED',
      section: 'hr',
      old_value: existing.name,
      changed_by: changedBy ?? 'system',
    });
    return record;
  }

  // Staff categories CRUD
  private normalizeCategoryCode(code: string): string {
    return code.trim().toUpperCase().replace(/\s+/g, '_');
  }

  async createStaffCategory(departmentId: number, dto: CreateStaffCategoryDto, changedBy?: string) {
    await this.findOne(departmentId);
    const code = this.normalizeCategoryCode(dto.code);
    if (!code) {
      throw new BadRequestException('code is required');
    }

    try {
      const record = await this.prisma.staff_categories.create({
        data: {
          department_id: departmentId,
          code,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          employee_code_dep: dto.employee_code_dep?.trim() || null,
        },
        include: { _count: { select: { employee_profiles: true } } },
      });
      this.auditLogs.log({
        entity_type: 'STAFF_CATEGORY',
        entity_id: String(record.id),
        action: 'CREATED',
        section: 'hr',
        new_value: record.name,
        changed_by: changedBy ?? 'system',
      });
      return record;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException('A category with this code or name already exists in this department');
      }
      throw err;
    }
  }

  async updateStaffCategory(
    departmentId: number,
    categoryId: number,
    dto: Partial<CreateStaffCategoryDto>,
    changedBy?: string,
  ) {
    const existing = await this.prisma.staff_categories.findUnique({
      where: { id: categoryId },
    });
    if (!existing || existing.department_id !== departmentId) {
      throw new NotFoundException(
        `Staff category with ID ${categoryId} not found in department ${departmentId}`,
      );
    }

    const data: { code?: string; name?: string; description?: string | null; employee_code_dep?: string | null } = {};
    if (dto.code !== undefined) data.code = this.normalizeCategoryCode(dto.code);
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.employee_code_dep !== undefined) data.employee_code_dep = dto.employee_code_dep?.trim() || null;

    try {
      const record = await this.prisma.staff_categories.update({
        where: { id: categoryId },
        data,
        include: { _count: { select: { employee_profiles: true } } },
      });
      this.auditLogs.log({
        entity_type: 'STAFF_CATEGORY',
        entity_id: String(categoryId),
        action: 'UPDATED',
        section: 'hr',
        old_value: existing.name,
        new_value: record.name,
        changed_by: changedBy ?? 'system',
      });
      return record;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException('A category with this code or name already exists in this department');
      }
      throw err;
    }
  }

  async removeStaffCategory(departmentId: number, categoryId: number, changedBy?: string) {
    const existing = await this.prisma.staff_categories.findUnique({
      where: { id: categoryId },
      include: { _count: { select: { employee_profiles: true, academic_calendar_days: true } } },
    });
    if (!existing || existing.department_id !== departmentId) {
      throw new NotFoundException(
        `Staff category with ID ${categoryId} not found in department ${departmentId}`,
      );
    }

    if (existing._count.employee_profiles > 0) {
      throw new ConflictException(
        `Cannot delete category "${existing.name}" — ${existing._count.employee_profiles} employee(s) assigned. Reassign them first.`,
      );
    }
    if (existing._count.academic_calendar_days > 0) {
      throw new ConflictException(
        `Cannot delete category "${existing.name}" — ${existing._count.academic_calendar_days} calendar day(s) still reference it.`,
      );
    }

    const record = await this.prisma.staff_categories.delete({ where: { id: categoryId } });
    this.auditLogs.log({
      entity_type: 'STAFF_CATEGORY',
      entity_id: String(categoryId),
      action: 'DELETED',
      section: 'hr',
      old_value: existing.name,
      changed_by: changedBy ?? 'system',
    });
    return record;
  }
}
