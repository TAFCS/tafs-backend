import { Injectable, NotFoundException, ConflictException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../../../prisma/prisma.service';
import {
  IsOptional, IsString, IsNumber, IsInt, IsArray, IsBoolean, IsEnum, IsEmail,
  ValidateNested, Min, MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';

export class ClassSectionAssignmentDto {
  @IsInt()
  class_id: number;

  @IsInt()
  section_id: number;
}

export class CreateEmployeeDto {
  @IsOptional() @IsString()
  user_id?: string;

  @IsOptional() @IsString()
  cnic?: string;

  @IsOptional() @IsString()
  join_date?: string;

  @IsOptional() @IsString()
  employment_type?: string;

  @IsOptional() @IsInt()
  department_id?: number;

  @IsOptional() @IsInt()
  designation_id?: number;

  @IsOptional() @IsInt()
  reporting_manager_id?: number;

  @IsOptional() @IsString()
  employee_code?: string;

  @IsOptional() @IsString()
  full_name?: string;

  @IsOptional() @IsString()
  father_name?: string;

  @IsOptional() @IsString()
  mother_name?: string;

  @IsOptional() @IsString()
  date_of_birth?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsString()
  personal_phone?: string;

  @IsOptional() @IsString()
  personal_email?: string;

  @IsOptional() @IsString()
  job_title?: string;

  @IsOptional() @IsString()
  staff_category?: string;

  @IsOptional() @IsString()
  job_description?: string;

  @IsOptional() @IsString()
  notes?: string;

  @IsOptional() @IsString()
  reporting_time?: string;

  @IsOptional() @IsString()
  leaving_time?: string;

  @IsOptional() @IsInt() @Min(0)
  late_relaxation_minutes?: number;

  @IsOptional() @IsNumber()
  monthly_pay?: number;

  @IsOptional() @IsInt()
  staff_type_id?: number;

  @IsOptional() @IsInt()
  campus_id?: number;

  @IsOptional() @IsInt()
  days_per_week?: number;

  @IsOptional() @IsString()
  photo_url?: string | null;

  @IsOptional() @IsString()
  account_number?: string;

  @IsOptional() @IsString()
  bank_name?: string;

  @IsOptional() @IsString()
  emergency_contact_name?: string;

  @IsOptional() @IsString()
  emergency_contact_phone?: string;

  @IsOptional() @IsString()
  emergency_contact_relationship?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClassSectionAssignmentDto)
  class_section_assignments?: ClassSectionAssignmentDto[];
}

export class UpdateEmployeeDto extends CreateEmployeeDto {}

export class WorkScheduleDayDto {
  @IsInt()
  day_of_week: number;

  @IsOptional()
  @IsBoolean()
  is_working?: boolean;
}

export class UpdateWorkScheduleDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkScheduleDayDto)
  days: WorkScheduleDayDto[];
}

export class UpdateEmployeeAccountDto {
  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional()
  @IsEnum(StaffRole)
  role?: StaffRole;

  @IsOptional() @IsInt()
  campus_id?: number | null;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  allowed_class_ids?: number[];
}

export class ResetEmployeePasswordDto {
  @IsString()
  @MinLength(8)
  password: string;
}

const nullIfEmpty = (value?: string | null) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const includeRelations = {
  users: {
    select: {
      id: true,
      username: true,
      full_name: true,
      role: true,
      email: true,
      is_active: true,
      campus_id: true,
      allowed_class_ids: true,
    },
  },
  departments: true,
  designations: true,
  staff_types: true,
  campuses: true,
  reporting_manager: {
    include: { users: { select: { full_name: true } } }
  },
  employee_class_section_assignments: {
    include: { classes: true, sections: true }
  }
};

const toTime = (value?: string) => (value ? new Date(`1970-01-01T${value}:00Z`) : null);

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Throws ConflictException if employee_code is already taken by another record */
  private async assertCodeAvailable(code: string, excludeId?: number) {
    const existing = await this.prisma.employee_profiles.findFirst({
      where: {
        employee_code: { equals: code, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true, full_name: true },
    });
    if (existing) {
      const who = existing.full_name ? ` (${existing.full_name})` : '';
      throw new ConflictException(
        `Employee code "${code}" is already assigned to another employee${who}. Please choose a different code.`
      );
    }
  }

  async findAll() {
    return this.prisma.employee_profiles.findMany({
      include: includeRelations
    });
  }

  async findOne(id: number) {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id },
      include: includeRelations
    });
    if (!employee) {
      throw new NotFoundException(`Employee profile with ID ${id} not found`);
    }
    return employee;
  }

  async create(dto: CreateEmployeeDto) {
    const { class_section_assignments, ...rest } = dto;

    // Check employee code uniqueness before insert
    if (rest.employee_code) {
      await this.assertCodeAvailable(rest.employee_code);
    }
    return this.prisma.employee_profiles.create({
      data: {
        user_id: rest.user_id || null,
        cnic: rest.cnic || null,
        join_date: rest.join_date ? new Date(rest.join_date) : null,
        employment_type: rest.employment_type || null,
        department_id: rest.department_id || null,
        designation_id: rest.designation_id || null,
        reporting_manager_id: rest.reporting_manager_id || null,
        employee_code: rest.employee_code || null,
        full_name: rest.full_name || null,
        father_name: rest.father_name || null,
        mother_name: rest.mother_name || null,
        date_of_birth: rest.date_of_birth ? new Date(rest.date_of_birth) : null,
        address: rest.address || null,
        personal_phone: rest.personal_phone || null,
        personal_email: rest.personal_email || null,
        job_title: rest.job_title || null,
        staff_category: (rest.staff_category as any) || null,
        job_description: rest.job_description || null,
        notes: rest.notes || null,
        reporting_time: toTime(rest.reporting_time),
        leaving_time: toTime(rest.leaving_time),
        late_relaxation_minutes: rest.late_relaxation_minutes ?? null,
        monthly_pay: rest.monthly_pay ?? null,
        staff_type_id: rest.staff_type_id || null,
        campus_id: rest.campus_id || null,
        days_per_week: rest.days_per_week ?? null,
        account_number: rest.account_number || null,
        bank_name: rest.bank_name || null,
        emergency_contact_name: rest.emergency_contact_name || null,
        emergency_contact_phone: rest.emergency_contact_phone || null,
        emergency_contact_relationship: rest.emergency_contact_relationship || null,
        employee_class_section_assignments: class_section_assignments?.length
          ? {
              create: class_section_assignments.map((a) => ({
                class_id: a.class_id,
                section_id: a.section_id
              }))
            }
          : undefined
      },
      include: includeRelations
    });
  }

  async update(id: number, dto: UpdateEmployeeDto) {
    await this.findOne(id);

    // Check code uniqueness, excluding this employee's own record
    if (dto.employee_code) {
      await this.assertCodeAvailable(dto.employee_code, id);
    }
    const { class_section_assignments, ...rest } = dto;

    return this.prisma.$transaction(async (tx) => {
      if (class_section_assignments !== undefined) {
        await tx.employee_class_section_assignments.deleteMany({ where: { employee_id: id } });
        if (class_section_assignments.length) {
          await tx.employee_class_section_assignments.createMany({
            data: class_section_assignments.map((a) => ({
              employee_id: id,
              class_id: a.class_id,
              section_id: a.section_id
            }))
          });
        }
      }

      return tx.employee_profiles.update({
        where: { id },
        data: {
          user_id: rest.user_id !== undefined ? rest.user_id : undefined,
          cnic: rest.cnic !== undefined ? rest.cnic : undefined,
          join_date: rest.join_date !== undefined ? (rest.join_date ? new Date(rest.join_date) : null) : undefined,
          employment_type: rest.employment_type !== undefined ? rest.employment_type : undefined,
          department_id: rest.department_id !== undefined ? rest.department_id : undefined,
          designation_id: rest.designation_id !== undefined ? rest.designation_id : undefined,
          reporting_manager_id: rest.reporting_manager_id !== undefined ? rest.reporting_manager_id : undefined,
          employee_code: rest.employee_code !== undefined ? nullIfEmpty(rest.employee_code) : undefined,
          full_name: rest.full_name !== undefined ? nullIfEmpty(rest.full_name) : undefined,
          father_name: rest.father_name !== undefined ? nullIfEmpty(rest.father_name) : undefined,
          mother_name: rest.mother_name !== undefined ? nullIfEmpty(rest.mother_name) : undefined,
          date_of_birth:
            rest.date_of_birth !== undefined ? (rest.date_of_birth ? new Date(rest.date_of_birth) : null) : undefined,
          address: rest.address !== undefined ? nullIfEmpty(rest.address) : undefined,
          personal_phone: rest.personal_phone !== undefined ? nullIfEmpty(rest.personal_phone) : undefined,
          personal_email: rest.personal_email !== undefined ? nullIfEmpty(rest.personal_email) : undefined,
          job_title: rest.job_title !== undefined ? nullIfEmpty(rest.job_title) : undefined,
          staff_category: rest.staff_category !== undefined ? (rest.staff_category as any) : undefined,
          job_description: rest.job_description !== undefined ? nullIfEmpty(rest.job_description) : undefined,
          notes: rest.notes !== undefined ? nullIfEmpty(rest.notes) : undefined,
          reporting_time: rest.reporting_time !== undefined ? toTime(rest.reporting_time ?? undefined) : undefined,
          leaving_time: rest.leaving_time !== undefined ? toTime(rest.leaving_time ?? undefined) : undefined,
          late_relaxation_minutes: rest.late_relaxation_minutes !== undefined ? rest.late_relaxation_minutes : undefined,
          monthly_pay: rest.monthly_pay !== undefined ? rest.monthly_pay : undefined,
          staff_type_id: rest.staff_type_id !== undefined ? rest.staff_type_id : undefined,
          campus_id: rest.campus_id !== undefined ? rest.campus_id : undefined,
          days_per_week: rest.days_per_week !== undefined ? rest.days_per_week : undefined,
          photo_url: rest.photo_url !== undefined ? rest.photo_url : undefined,
          account_number: rest.account_number !== undefined ? nullIfEmpty(rest.account_number) : undefined,
          bank_name: rest.bank_name !== undefined ? nullIfEmpty(rest.bank_name) : undefined,
          emergency_contact_name: rest.emergency_contact_name !== undefined ? nullIfEmpty(rest.emergency_contact_name) : undefined,
          emergency_contact_phone: rest.emergency_contact_phone !== undefined ? nullIfEmpty(rest.emergency_contact_phone) : undefined,
          emergency_contact_relationship:
            rest.emergency_contact_relationship !== undefined ? nullIfEmpty(rest.emergency_contact_relationship) : undefined,
        },
        include: includeRelations
      });
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.employee_profiles.delete({
      where: { id }
    });
  }

  async findUnlinkedUsers() {
    // Find all active staff users who do not have an employee profile linked
    return this.prisma.users.findMany({
      where: {
        is_active: true,
        employee_profile: null,
      },
      select: {
        id: true,
        full_name: true,
        email: true,
        role: true,
      }
    });
  }

  async searchSimple(query: string) {
    const isNumeric = /^\d+$/.test(query);
    const results: { id: number; full_name: string | null; employee_code: string | null }[] = [];

    if (isNumeric) {
      const exact = await this.prisma.employee_profiles.findFirst({
        where: { id: Number(query) },
        select: { id: true, full_name: true, employee_code: true },
      });
      if (exact) results.push(exact);
    }

    const others = await this.prisma.employee_profiles.findMany({
      where: {
        OR: [
          { full_name: { contains: query, mode: 'insensitive' } },
          { employee_code: { contains: query, mode: 'insensitive' } },
        ],
        ...(results.length ? { NOT: { id: results[0].id } } : {}),
      },
      select: { id: true, full_name: true, employee_code: true },
      orderBy: { full_name: 'asc' },
      take: 5 - results.length,
    });

    return [...results, ...others];
  }

  async getNextEmployeeCode(): Promise<{ code: string }> {
    // Find all employee codes that match EMP-NNNN pattern and return next one
    const employees = await this.prisma.employee_profiles.findMany({
      select: { employee_code: true },
      where: { employee_code: { not: null } },
    });

    let maxNum = 0;
    for (const emp of employees) {
      if (!emp.employee_code) continue;
      const match = emp.employee_code.match(/^EMP-(\d+)$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }

    const nextNum = maxNum + 1;
    const code = `EMP-${String(nextNum).padStart(4, '0')}`;
    return { code };
  }

  async getWorkSchedule(employeeId: number) {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { id: true, days_per_week: true, employee_work_schedules: true },
    });
    if (!employee) throw new NotFoundException(`Employee with ID ${employeeId} not found`);

    return {
      employee_id: employee.id,
      days_per_week: employee.days_per_week,
      has_custom_schedule: employee.employee_work_schedules.length > 0,
      days: employee.employee_work_schedules.sort((a, b) => a.day_of_week - b.day_of_week),
    };
  }

  async updateWorkSchedule(employeeId: number, dto: UpdateWorkScheduleDto) {
    const employee = await this.prisma.employee_profiles.findUnique({ where: { id: employeeId } });
    if (!employee) throw new NotFoundException(`Employee with ID ${employeeId} not found`);

    for (const day of dto.days) {
      if (day.day_of_week < 0 || day.day_of_week > 6) {
        throw new BadRequestException('day_of_week must be between 0 (Sunday) and 6 (Saturday)');
      }
    }

    await this.prisma.$transaction([
      this.prisma.employee_work_schedules.deleteMany({ where: { employee_id: employeeId } }),
      ...dto.days.map((day) =>
        this.prisma.employee_work_schedules.create({
          data: {
            employee_id: employeeId,
            day_of_week: day.day_of_week,
            is_working: day.is_working ?? true,
          },
        }),
      ),
    ]);

    return this.getWorkSchedule(employeeId);
  }

  async clearWorkSchedule(employeeId: number) {
    const employee = await this.prisma.employee_profiles.findUnique({ where: { id: employeeId } });
    if (!employee) throw new NotFoundException(`Employee with ID ${employeeId} not found`);

    await this.prisma.employee_work_schedules.deleteMany({ where: { employee_id: employeeId } });
    return this.getWorkSchedule(employeeId);
  }

  async updateAccount(employeeId: number, dto: UpdateEmployeeAccountDto, caller: IJwtStaffPayload) {
    const employee = await this.findOne(employeeId);
    if (!employee.user_id) {
      throw new BadRequestException('This employee has no linked portal account.');
    }

    if (dto.role === StaffRole.SUPER_ADMIN && caller.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can assign the SUPER_ADMIN role.');
    }

    if (dto.email !== undefined) {
      const email = dto.email.trim();
      if (email) {
        const existing = await this.prisma.users.findFirst({
          where: { email, NOT: { id: employee.user_id } },
        });
        if (existing) {
          throw new ConflictException('Email is already in use by another account.');
        }
      }
    }

    return this.prisma.users.update({
      where: { id: employee.user_id },
      data: {
        email: dto.email !== undefined ? (dto.email.trim() || null) : undefined,
        role: dto.role !== undefined ? dto.role : undefined,
        campus_id: dto.campus_id !== undefined ? dto.campus_id : undefined,
        is_active: dto.is_active !== undefined ? dto.is_active : undefined,
        allowed_class_ids: dto.allowed_class_ids !== undefined ? dto.allowed_class_ids : undefined,
      },
      select: {
        id: true,
        username: true,
        full_name: true,
        role: true,
        email: true,
        is_active: true,
        campus_id: true,
        allowed_class_ids: true,
      },
    });
  }

  async resetAccountPassword(employeeId: number, dto: ResetEmployeePasswordDto) {
    const employee = await this.findOne(employeeId);
    if (!employee.user_id) {
      throw new BadRequestException('This employee has no linked portal account.');
    }
    if (!dto.password || dto.password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters.');
    }

    const password_hash = await bcrypt.hash(dto.password, 10);
    await this.prisma.users.update({
      where: { id: employee.user_id },
      data: { password_hash },
    });
    return { success: true };
  }
}
