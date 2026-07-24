import { Injectable, NotFoundException, ConflictException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { CheckInSource, EmployeeStatus, StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../../../prisma/prisma.service';
import {
  IsOptional, IsString, IsNumber, IsInt, IsArray, IsBoolean, IsEnum, IsEmail,
  ValidateNested, Min, MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { composeEmployeeCode, parseEmployeeCode, resolveEmployeeCodeFields, campusPrefixForId } from './employee-code.util';

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

  @IsOptional()
  @IsEnum(EmployeeStatus)
  employment_status?: EmployeeStatus;

  @IsOptional() @IsInt()
  department_id?: number;

  @IsOptional() @IsInt()
  designation_id?: number;

  @IsOptional() @IsInt()
  reporting_manager_id?: number;

  @IsOptional() @IsString()
  employee_code?: string;

  @IsOptional() @IsString()
  employee_code_dep?: string;

  @IsOptional() @IsString()
  employee_code_number?: string;

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

  @IsOptional() @IsInt()
  staff_category_id?: number | null;

  @IsOptional() @IsString()
  job_description?: string;

  @IsOptional() @IsString()
  notes?: string;

  @IsOptional() @IsString()
  reporting_time?: string;

  @IsOptional() @IsString()
  leaving_time?: string;

  @IsOptional() @IsEnum(CheckInSource)
  check_in_source?: CheckInSource;

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
  father_photo_url?: string | null;

  @IsOptional() @IsString()
  father_cnic?: string | null;

  @IsOptional() @IsString()
  mother_photo_url?: string | null;

  @IsOptional() @IsString()
  mother_cnic?: string | null;

  @IsOptional() @IsString()
  spouse_name?: string | null;

  @IsOptional() @IsString()
  spouse_cnic?: string | null;

  @IsOptional() @IsString()
  spouse_photo_url?: string | null;

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

export class UpdateEmployeeStatusDto {
  @IsEnum(EmployeeStatus)
  status: EmployeeStatus;
}

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
  staff_categories: true,
  staff_types: true,
  campuses: true,
  reporting_manager: {
    include: { users: { select: { full_name: true } } }
  },
  employee_class_section_assignments: {
    include: {
      classes: { include: { segments: true } },
      sections: true,
    },
  }
};

const toTime = (value?: string) => (value ? new Date(`1970-01-01T${value}:00Z`) : null);

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /** Ensure staff category belongs to the employee's department. */
  private async assertCategoryMatchesDepartment(
    departmentId: number | null | undefined,
    staffCategoryId: number | null | undefined,
  ) {
    if (staffCategoryId == null) return;
    const category = await this.prisma.staff_categories.findUnique({
      where: { id: staffCategoryId },
      select: { id: true, department_id: true, name: true },
    });
    if (!category) {
      throw new BadRequestException(`Staff category ${staffCategoryId} not found`);
    }
    if (departmentId == null) {
      throw new BadRequestException('department_id is required when assigning a staff category');
    }
    if (category.department_id !== departmentId) {
      throw new BadRequestException(
        `Staff category "${category.name}" does not belong to the selected department`,
      );
    }
  }

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

  async getMine(userId: string) {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { user_id: userId },
      select: {
        id: true,
        employee_code: true,
        employee_code_dep: true,
        employee_code_number: true,
        full_name: true,
        job_title: true,
        staff_category_id: true,
        join_date: true,
        personal_phone: true,
        personal_email: true,
        photo_url: true,
        is_permanent_employee: true,
        employment_status: true,
        campuses: { select: { id: true, campus_name: true } },
        departments: { select: { id: true, name: true } },
        designations: { select: { id: true, title: true } },
        staff_categories: { select: { id: true, code: true, name: true, department_id: true } },
        users: { select: { id: true, username: true, full_name: true, role: true } },
      },
    });
    if (!employee) {
      throw new ForbiddenException('No employee profile is linked to this account');
    }
    return employee;
  }

  async create(dto: CreateEmployeeDto, changedBy?: string, caller?: IJwtStaffPayload) {
    const { class_section_assignments, employment_status, ...rest } = dto;
    const codeFields = resolveEmployeeCodeFields({
      ...rest,
      campusPrefix: campusPrefixForId(rest.campus_id ?? null),
    });

    if (codeFields.employee_code) {
      await this.assertCodeAvailable(codeFields.employee_code);
    }
    await this.assertCategoryMatchesDepartment(rest.department_id ?? null, rest.staff_category_id ?? null);

    let status: EmployeeStatus = EmployeeStatus.ACTIVE;
    if (employment_status != null) {
      if (caller?.role !== StaffRole.SUPER_ADMIN) {
        throw new ForbiddenException('Only super admins can set employee status');
      }
      status = employment_status;
    }

    const record = await this.prisma.employee_profiles.create({
      data: {
        user_id: rest.user_id || null,
        cnic: rest.cnic || null,
        join_date: rest.join_date ? new Date(rest.join_date) : null,
        employment_type: rest.employment_type || null,
        employment_status: status,
        is_permanent_employee: status === EmployeeStatus.PERMANENT,
        department_id: rest.department_id || null,
        designation_id: rest.designation_id || null,
        reporting_manager_id: rest.reporting_manager_id || null,
        employee_code: codeFields.employee_code,
        employee_code_dep: codeFields.employee_code_dep,
        employee_code_number: codeFields.employee_code_number,
        full_name: rest.full_name || null,
        father_name: rest.father_name || null,
        mother_name: rest.mother_name || null,
        date_of_birth: rest.date_of_birth ? new Date(rest.date_of_birth) : null,
        address: rest.address || null,
        personal_phone: rest.personal_phone || null,
        personal_email: rest.personal_email || null,
        job_title: rest.job_title || null,
        staff_category_id: rest.staff_category_id ?? null,
        job_description: rest.job_description || null,
        notes: rest.notes || null,
        reporting_time: toTime(rest.reporting_time),
        leaving_time: toTime(rest.leaving_time),
        check_in_source: rest.check_in_source ?? CheckInSource.FIXED,
        late_relaxation_minutes: rest.late_relaxation_minutes ?? null,
        monthly_pay: rest.monthly_pay ?? null,
        staff_type_id: rest.staff_type_id || null,
        campus_id: rest.campus_id || null,
        days_per_week: rest.days_per_week ?? null,
        photo_url: rest.photo_url || null,
        father_photo_url: rest.father_photo_url || null,
        father_cnic: rest.father_cnic || null,
        mother_photo_url: rest.mother_photo_url || null,
        mother_cnic: rest.mother_cnic || null,
        spouse_name: rest.spouse_name || null,
        spouse_cnic: rest.spouse_cnic || null,
        spouse_photo_url: rest.spouse_photo_url || null,
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
    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(record.id),
      action: 'CREATED',
      section: 'hr',
      new_value: record.full_name ?? record.employee_code ?? undefined,
      changed_by: changedBy ?? 'system',
    });
    return record;
  }

  async update(id: number, dto: UpdateEmployeeDto, changedBy?: string) {
    const existing = await this.findOne(id);

    const { class_section_assignments, employment_status: _ignoredStatus, ...rest } = dto;
    if (_ignoredStatus !== undefined) {
      throw new BadRequestException('Use PATCH /hr/employees/:id/status to change employment status');
    }
    const nextCampusId = rest.campus_id !== undefined ? rest.campus_id : existing.campus_id;
    const hasCodeInput =
      rest.employee_code !== undefined ||
      rest.employee_code_dep !== undefined ||
      rest.employee_code_number !== undefined;
    // If campus changes but code fields weren't touched, still recompose with the new prefix
    const campusChanged =
      rest.campus_id !== undefined && rest.campus_id !== existing.campus_id;
    const shouldResolveCode = hasCodeInput || campusChanged;
    const codeFields = shouldResolveCode
      ? resolveEmployeeCodeFields({
          employee_code: hasCodeInput ? rest.employee_code : existing.employee_code,
          employee_code_dep: hasCodeInput
            ? rest.employee_code_dep
            : existing.employee_code_dep,
          employee_code_number: hasCodeInput
            ? rest.employee_code_number
            : existing.employee_code_number,
          campusPrefix: campusPrefixForId(nextCampusId),
        })
      : null;

    if (codeFields?.employee_code) {
      await this.assertCodeAvailable(codeFields.employee_code, id);
    }

    const nextDepartmentId =
      rest.department_id !== undefined ? rest.department_id : existing.department_id;
    const nextCategoryId =
      rest.staff_category_id !== undefined ? rest.staff_category_id : existing.staff_category_id;
    await this.assertCategoryMatchesDepartment(nextDepartmentId, nextCategoryId);

    const result = await this.prisma.$transaction(async (tx) => {
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
          employee_code: codeFields
            ? codeFields.employee_code
            : rest.employee_code !== undefined
              ? nullIfEmpty(rest.employee_code)
              : undefined,
          employee_code_dep: codeFields ? codeFields.employee_code_dep : undefined,
          employee_code_number: codeFields ? codeFields.employee_code_number : undefined,
          full_name: rest.full_name !== undefined ? nullIfEmpty(rest.full_name) : undefined,
          father_name: rest.father_name !== undefined ? nullIfEmpty(rest.father_name) : undefined,
          mother_name: rest.mother_name !== undefined ? nullIfEmpty(rest.mother_name) : undefined,
          date_of_birth:
            rest.date_of_birth !== undefined ? (rest.date_of_birth ? new Date(rest.date_of_birth) : null) : undefined,
          address: rest.address !== undefined ? nullIfEmpty(rest.address) : undefined,
          personal_phone: rest.personal_phone !== undefined ? nullIfEmpty(rest.personal_phone) : undefined,
          personal_email: rest.personal_email !== undefined ? nullIfEmpty(rest.personal_email) : undefined,
          job_title: rest.job_title !== undefined ? nullIfEmpty(rest.job_title) : undefined,
          staff_category_id: rest.staff_category_id !== undefined ? rest.staff_category_id : undefined,
          job_description: rest.job_description !== undefined ? nullIfEmpty(rest.job_description) : undefined,
          notes: rest.notes !== undefined ? nullIfEmpty(rest.notes) : undefined,
          reporting_time: rest.reporting_time !== undefined ? toTime(rest.reporting_time ?? undefined) : undefined,
          leaving_time: rest.leaving_time !== undefined ? toTime(rest.leaving_time ?? undefined) : undefined,
          check_in_source: rest.check_in_source !== undefined ? rest.check_in_source : undefined,
          late_relaxation_minutes: rest.late_relaxation_minutes !== undefined ? rest.late_relaxation_minutes : undefined,
          monthly_pay: rest.monthly_pay !== undefined ? rest.monthly_pay : undefined,
          staff_type_id: rest.staff_type_id !== undefined ? rest.staff_type_id : undefined,
          campus_id: rest.campus_id !== undefined ? rest.campus_id : undefined,
          days_per_week: rest.days_per_week !== undefined ? rest.days_per_week : undefined,
          photo_url: rest.photo_url !== undefined ? rest.photo_url : undefined,
          father_photo_url: rest.father_photo_url !== undefined ? rest.father_photo_url : undefined,
          father_cnic: rest.father_cnic !== undefined ? nullIfEmpty(rest.father_cnic) : undefined,
          mother_photo_url: rest.mother_photo_url !== undefined ? rest.mother_photo_url : undefined,
          mother_cnic: rest.mother_cnic !== undefined ? nullIfEmpty(rest.mother_cnic) : undefined,
          spouse_name: rest.spouse_name !== undefined ? nullIfEmpty(rest.spouse_name) : undefined,
          spouse_cnic: rest.spouse_cnic !== undefined ? nullIfEmpty(rest.spouse_cnic) : undefined,
          spouse_photo_url: rest.spouse_photo_url !== undefined ? rest.spouse_photo_url : undefined,
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

    const trackedFields: Array<{ key: keyof typeof rest | 'employee_code_dep' | 'employee_code_number'; label: string; oldKey?: string }> = [
      { key: 'full_name', label: 'Full Name' },
      { key: 'employee_code', label: 'Code' },
      { key: 'employee_code_dep', label: 'Code Dept', oldKey: 'employee_code_dep' },
      { key: 'employee_code_number', label: 'Code Number', oldKey: 'employee_code_number' },
      { key: 'cnic', label: 'CNIC' },
      { key: 'job_title', label: 'Job Title' },
      { key: 'employment_type', label: 'Employment Type' },
      { key: 'department_id', label: 'Department' },
      { key: 'designation_id', label: 'Designation' },
      { key: 'campus_id', label: 'Campus' },
      { key: 'personal_phone', label: 'Phone' },
      { key: 'personal_email', label: 'Email' },
      { key: 'monthly_pay', label: 'Monthly Pay' },
    ];

    const changes: string[] = [];
    for (const { key, label, oldKey } of trackedFields) {
      const sourceKey = oldKey ?? key;
      if (codeFields && (key === 'employee_code' || key === 'employee_code_dep' || key === 'employee_code_number')) {
        const oldVal = String((existing as any)[sourceKey] ?? '');
        const newVal = String((codeFields as any)[sourceKey] ?? '');
        if (oldVal !== newVal) {
          changes.push(`${label}: ${oldVal || '—'} → ${newVal || '—'}`);
        }
        continue;
      }
      if (key in rest && rest[key as keyof typeof rest] !== undefined) {
        const oldVal = String((existing as any)[sourceKey] ?? '');
        const newVal = String(rest[key as keyof typeof rest] ?? '');
        if (oldVal !== newVal) {
          changes.push(`${label}: ${oldVal || '—'} → ${newVal || '—'}`);
        }
      }
    }

    if (changes.length > 0) {
      this.auditLogs.log({
        entity_type: 'EMPLOYEE',
        entity_id: String(id),
        action: 'UPDATED',
        section: 'hr',
        note: `${(existing as any).full_name ?? `#${id}`} — ${changes.join(' | ')}`,
        changed_by: changedBy ?? 'system',
      });
    }

    return result;
  }

  async remove(id: number, changedBy?: string) {
    const existing = await this.findOne(id);
    const record = await this.prisma.employee_profiles.delete({
      where: { id }
    });
    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(id),
      action: 'DELETED',
      section: 'hr',
      old_value: (existing as any).full_name ?? (existing as any).employee_code ?? undefined,
      changed_by: changedBy ?? 'system',
    });
    return record;
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
    const trimmed = (query || '').trim();
    if (!trimmed) return [];

    const isNumeric = /^\d+$/.test(trimmed);
    const results: { id: number; full_name: string | null; employee_code: string | null }[] = [];

    // Helper: generate code patterns from raw PIN digits (e.g. 40050117 -> '04-0050117', 300648 -> '03-00648', 30049 -> '03-0049')
    const codePatterns: string[] = [];
    if (isNumeric) {
      if (trimmed.length >= 5) {
        const rawDep = trimmed.substring(0, 2);
        const rawNum = trimmed.substring(2);
        let convDep = rawDep;
        if (rawDep.endsWith('0')) {
          convDep = '0' + rawDep[0];
        }
        codePatterns.push(`${convDep}-${rawNum}`);
        codePatterns.push(`${convDep}-${rawNum.padStart(4, '0')}`);
        codePatterns.push(`${rawDep}-${rawNum}`);
      }
      if (trimmed.length >= 4) {
        const singleDep = '0' + trimmed[0];
        const rest = trimmed.substring(1);
        codePatterns.push(`${singleDep}-${rest}`);
        codePatterns.push(`${singleDep}-${rest.padStart(4, '0')}`);
      }
    }

    if (isNumeric) {
      const exact = await this.prisma.employee_profiles.findFirst({
        where: { id: Number(trimmed) },
        select: { id: true, full_name: true, employee_code: true },
      });
      if (exact) results.push(exact);
    }

    const orConditions: any[] = [
      { full_name: { contains: trimmed, mode: 'insensitive' } },
      { employee_code: { contains: trimmed, mode: 'insensitive' } },
    ];

    for (const pat of codePatterns) {
      orConditions.push({ employee_code: { contains: pat, mode: 'insensitive' } });
    }

    const others = await this.prisma.employee_profiles.findMany({
      where: {
        OR: orConditions,
        ...(results.length ? { NOT: { id: results[0].id } } : {}),
      },
      select: { id: true, full_name: true, employee_code: true },
      orderBy: { full_name: 'asc' },
      take: 10 - results.length,
    });

    return [...results, ...others];
  }

  async getNextEmployeeCode(dep?: string): Promise<{ dep: string | null; number: string; code: string }> {
    const normalizedDep = dep?.trim();
    if (normalizedDep) {
      const depCode = normalizedDep.padStart(2, '0');
      const employees = await this.prisma.employee_profiles.findMany({
        select: { employee_code: true, employee_code_dep: true, employee_code_number: true },
        where: {
          OR: [
            { employee_code_dep: depCode },
            { employee_code: { startsWith: `${depCode}-`, mode: 'insensitive' } },
            { employee_code: { contains: `-${depCode}-`, mode: 'insensitive' } },
          ],
        },
      });

      let maxNum = 0;
      let padWidth = 4;
      for (const emp of employees) {
        const numberPart =
          emp.employee_code_number ??
          parseEmployeeCode(emp.employee_code ?? undefined)?.number ??
          null;
        if (!numberPart) continue;
        const digits = numberPart.replace(/\D/g, '');
        if (!digits) continue;
        const num = parseInt(digits, 10);
        if (!Number.isFinite(num)) continue;
        if (num > maxNum) {
          maxNum = num;
          padWidth = Math.max(padWidth, numberPart.length);
        }
      }

      const nextNumber = String(maxNum + 1).padStart(padWidth, '0');
      return {
        dep: depCode,
        number: nextNumber,
        code: composeEmployeeCode(depCode, nextNumber),
      };
    }

    // Legacy EMP-NNNN suggestion for non-prefixed codes
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
    return { dep: null, number: String(nextNum).padStart(4, '0'), code };
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

  async updateStatus(id: number, dto: UpdateEmployeeStatusDto, caller: IJwtStaffPayload) {
    if (caller.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can change employee status');
    }

    const existing = await this.findOne(id);
    const nextStatus = dto.status;

    if (existing.employment_status === nextStatus) {
      return existing;
    }

    const deactivatePortal =
      nextStatus === EmployeeStatus.TERMINATED || nextStatus === EmployeeStatus.LEFT;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (deactivatePortal && existing.user_id) {
        await tx.users.update({
          where: { id: existing.user_id },
          data: { is_active: false },
        });
      }

      return tx.employee_profiles.update({
        where: { id },
        data: {
          employment_status: nextStatus,
          is_permanent_employee: nextStatus === EmployeeStatus.PERMANENT,
        },
        include: includeRelations,
      });
    });

    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(id),
      action: 'UPDATED',
      section: 'hr',
      field: 'Employment Status',
      old_value: existing.employment_status,
      new_value: nextStatus,
      changed_by: caller.username || caller.sub || 'system',
    });

    return updated;
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
