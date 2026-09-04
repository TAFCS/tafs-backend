import { Injectable, NotFoundException, ConflictException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { CheckInSource, EmployeeStatus, Prisma, StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../../../prisma/prisma.service';
import {
  IsOptional, IsString, IsNumber, IsInt, IsArray, IsBoolean, IsEnum, IsEmail,
  ValidateNested, Min, MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { composeEmployeeCode, parseEmployeeCode, resolveEmployeeCodeFields, campusPrefixForId } from './employee-code.util';
import { buildMasterEmployeesExcelBuffer } from './master-employee-excel.util';
import { encryptSecret, decryptSecret } from '../../../common/utils/reversible-secret.util';
import { isLegacyTafsEmailUsername } from '../../../common/utils/account-credentials.util';
import { CaslAbilityFactory } from '../../auth/casl/casl-ability.factory';
import { Action } from '../../auth/casl/actions';
import { v4 as uuidv4 } from 'uuid';
import { AccessService } from '../../access/access.service';
import { TileGrantDto } from '../../access/dto/access.dto';

export class ClassSectionAssignmentDto {
  @IsInt()
  class_id: number;

  @IsInt()
  section_id: number;
}

/** Portal login to create together with the employee profile, in one transaction. */
export class CreateEmployeePortalAccountDto {
  @IsString()
  @MinLength(3)
  username: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsEnum(StaffRole)
  role?: StaffRole;

  @IsOptional() @IsInt()
  campus_id?: number;
}

export class CreateEmployeeDto {
  /**
   * Create the portal login as part of this request. Preferred over creating the
   * user first via POST /users: a failure here rolls the account back instead of
   * leaving an orphan that makes the retry collide on "Username already taken".
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateEmployeePortalAccountDto)
  portal_account?: CreateEmployeePortalAccountDto;

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
  secondary_phone?: string;

  @IsOptional() @IsString()
  personal_email?: string;

  @IsOptional() @IsString()
  job_title?: string;

  @IsOptional() @IsInt()
  staff_category_id?: number | null;

  @IsOptional() @IsInt()
  segment_id?: number | null;

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

  @IsOptional() @IsBoolean()
  payroll_enabled?: boolean;

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

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  packIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TileGrantDto)
  tileGrants?: TileGrantDto[];
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

export class ChangeEmployeeUsernameDto {
  @IsString()
  @MinLength(3)
  username: string;
}

const nullIfEmpty = (value?: string | null) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const upperOrNull = (value?: string | null) => {
  const normalized = nullIfEmpty(value);
  return normalized ? normalized.toUpperCase() : normalized;
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
  staff_categories: true,
  segments: true,
  campuses: true,
  reporting_manager: {
    include: { users: { select: { full_name: true } } }
  },
  employee_class_section_assignments: {
    include: {
      classes: { include: { segments: true } },
      sections: true,
    },
  },
  device_user_mappings: true,
};

const toTime = (value?: string) => (value ? new Date(`1970-01-01T${value}:00Z`) : null);

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly caslAbilityFactory: CaslAbilityFactory,
    private readonly accessService: AccessService,
  ) {}

  async exportMasterExcel(): Promise<Buffer> {
    const employees = await this.prisma.employee_profiles.findMany({
      include: includeRelations,
      orderBy: { id: 'asc' },
    });
    return buildMasterEmployeesExcelBuffer(employees as any);
  }

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

  /** Throws ConflictException if the CNIC already belongs to another employee profile */
  private async assertCnicAvailable(cnic: string, excludeId?: number) {
    const existing = await this.prisma.employee_profiles.findFirst({
      where: {
        cnic: { equals: cnic, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true, full_name: true, employee_code: true },
    });
    if (existing) {
      const who = existing.full_name || existing.employee_code || `profile #${existing.id}`;
      throw new ConflictException(
        `CNIC "${cnic}" already belongs to ${who}. Open that profile instead of creating a second one.`,
      );
    }
  }

  /** Turns a raw unique-constraint violation into a message naming the field the admin typed. */
  private conflictFromUniqueViolation(err: unknown): ConflictException | null {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return null;
    const target = (err.meta as { target?: unknown } | undefined)?.target;
    const fields = (Array.isArray(target) ? target : [target]).map((f) => String(f ?? ''));
    const hits = (name: string) => fields.some((f) => f.includes(name));
    if (hits('cnic')) return new ConflictException('That CNIC is already on another employee profile.');
    if (hits('employee_code')) return new ConflictException('That employee code is already assigned to another employee.');
    if (hits('username')) return new ConflictException('Username already taken.');
    if (hits('user_id')) return new ConflictException('That portal account is already linked to another employee profile.');
    return null;
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
    const {
      class_section_assignments,
      employment_status,
      portal_account,
      packIds,
      tileGrants,
      payroll_enabled,
      ...rest
    } = dto;

    const timesOmitted = !rest.reporting_time || !rest.leaving_time;
    const effectiveCheckInSource =
      rest.check_in_source ?? (timesOmitted ? CheckInSource.TIMETABLE : CheckInSource.FIXED);
    if (effectiveCheckInSource === CheckInSource.FIXED && (!rest.reporting_time || !rest.leaving_time)) {
      throw new BadRequestException('Expected check-in and check-out times are required when payroll uses fixed times.');
    }

    const codeFields = resolveEmployeeCodeFields({
      ...rest,
      campusPrefix: campusPrefixForId(rest.campus_id ?? null),
    });

    if (codeFields.employee_code) {
      await this.assertCodeAvailable(codeFields.employee_code);
    }
    if (rest.cnic) {
      await this.assertCnicAvailable(rest.cnic);
    }
    await this.assertCategoryMatchesDepartment(rest.department_id ?? null, rest.staff_category_id ?? null);

    let status: EmployeeStatus = EmployeeStatus.ACTIVE;
    if (employment_status != null) {
      if (caller?.role !== StaffRole.SUPER_ADMIN) {
        throw new ForbiddenException('Only super admins can set employee status');
      }
      status = employment_status;
    }

    const account = await this.preparePortalAccount(portal_account, rest, caller);

    let record: any;
    try {
      record = await this.prisma.$transaction(async (tx) => {
        // The login is created inside the transaction so that any failure below —
        // a duplicate CNIC, a bad department — rolls the username back instead of
        // burning it and making the admin's retry collide.
        const userId = account
          ? (await tx.users.create({ data: account.data, select: { id: true } })).id
          : rest.user_id || null;

        return tx.employee_profiles.create({
          data: {
            user_id: userId,
            cnic: rest.cnic || null,
            join_date: rest.join_date ? new Date(rest.join_date) : null,
            employment_type: rest.employment_type || null,
            employment_status: status,
            is_permanent_employee: status === EmployeeStatus.PERMANENT,
            department_id: rest.department_id || null,
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
            secondary_phone: rest.secondary_phone || null,
            personal_email: rest.personal_email || null,
            job_title: upperOrNull(rest.job_title),
            staff_category_id: rest.staff_category_id ?? null,
            segment_id: rest.segment_id ?? null,
            job_description: upperOrNull(rest.job_description),
            notes: rest.notes || null,
            reporting_time: toTime(rest.reporting_time),
            leaving_time: toTime(rest.leaving_time),
            check_in_source: effectiveCheckInSource,
            late_relaxation_minutes: rest.late_relaxation_minutes ?? null,
            monthly_pay: rest.monthly_pay ?? null,
            payroll_enabled: payroll_enabled ?? rest.monthly_pay != null,
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
          include: includeRelations,
        });
      });
    } catch (err) {
      const conflict = this.conflictFromUniqueViolation(err);
      if (conflict) throw conflict;
      throw err;
    }

    if (account) {
      this.auditLogs.log({
        entity_type: 'USER',
        entity_id: record.user_id,
        action: 'CREATED',
        section: 'system',
        new_value: `${account.data.username} (${account.data.role})`,
        changed_by: caller?.sub || changedBy || 'system',
        note: `Created user ${account.data.username} (#${record.user_id}) with role ${account.data.role}` +
          (account.data.campus_id ? `, campus #${account.data.campus_id}` : '') +
          (account.data.full_name ? `, name "${account.data.full_name}"` : '') +
          ' as part of employee registration.',
      });
    }
    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(record.id),
      action: 'CREATED',
      section: 'hr',
      new_value: record.full_name ?? record.employee_code ?? undefined,
      changed_by: changedBy ?? 'system',
    });

    if (record.user_id && ((packIds && packIds.length > 0) || (tileGrants && tileGrants.length > 0))) {
      if (!caller?.sub) {
        throw new BadRequestException('Cannot assign access packs without an authenticated actor');
      }
      await this.accessService.setUserAccess(
        record.user_id,
        { packIds: packIds ?? [], tileGrants: tileGrants ?? [] },
        caller.sub,
        caller.username || changedBy,
      );
    }

    return record;
  }

  /**
   * Validates a requested portal login and returns the row to create, or null when
   * the caller did not ask for one. Everything that can be checked up front is
   * checked here so the transaction body stays a straight write.
   */
  private async preparePortalAccount(
    portalAccount: CreateEmployeePortalAccountDto | undefined,
    rest: Omit<CreateEmployeeDto, 'class_section_assignments' | 'employment_status' | 'portal_account'>,
    caller?: IJwtStaffPayload,
  ) {
    if (!portalAccount) return null;

    if (rest.user_id) {
      throw new BadRequestException(
        'Provide either an existing user_id to link or portal_account to create a new login — not both.',
      );
    }
    if (caller) {
      const ability = this.caslAbilityFactory.createForStaff(caller);
      if (!ability.can(Action.Create, 'User')) {
        throw new ForbiddenException('You do not have permission to create portal logins.');
      }
    }

    const username = portalAccount.username.trim();
    if (isLegacyTafsEmailUsername(username)) {
      throw new BadRequestException(
        'Usernames may no longer use the "@tafs.com" format — use a "name1.name2.name3" style username instead.',
      );
    }
    const role = portalAccount.role ?? StaffRole.EMPLOYEE;
    if (role === StaffRole.SUPER_ADMIN && caller?.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can assign the SUPER_ADMIN role.');
    }

    const taken = await this.prisma.users.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { id: true, employee_profile: { select: { id: true, full_name: true } } },
    });
    if (taken) {
      const linked = taken.employee_profile;
      throw new ConflictException(
        linked
          ? `Username "${username}" already belongs to ${linked.full_name || `employee #${linked.id}`}. Choose a different username.`
          : `Username "${username}" is already taken by an account with no employee profile. Choose a different username, or link that account instead.`,
      );
    }

    const now = new Date();
    return {
      data: {
        id: uuidv4(),
        username,
        full_name: rest.full_name?.trim() || username,
        password_hash: await bcrypt.hash(portalAccount.password, 10),
        password_reveal: encryptSecret(portalAccount.password),
        role,
        campus_id: portalAccount.campus_id ?? rest.campus_id ?? null,
        allowed_class_ids: [],
        is_active: true,
        created_at: now,
        updated_at: now,
      },
    };
  }

  async update(id: number, dto: UpdateEmployeeDto, changedBy?: string, caller?: IJwtStaffPayload) {
    const existing = await this.findOne(id);

    const {
      class_section_assignments,
      employment_status: _ignoredStatus,
      packIds: _packIds,
      tileGrants: _tileGrants,
      portal_account,
      ...rest
    } = dto;
    if (_ignoredStatus !== undefined) {
      throw new BadRequestException('Use PATCH /hr/employees/:id/status to change employment status');
    }
    if (portal_account && existing.user_id) {
      throw new BadRequestException('This employee already has a portal account.');
    }
    const account = await this.preparePortalAccount(portal_account, rest, caller);

    const nextCheckInSource = rest.check_in_source !== undefined ? rest.check_in_source : (existing as any).check_in_source;
    if (nextCheckInSource === CheckInSource.FIXED) {
      const nextReportingTime = rest.reporting_time !== undefined ? rest.reporting_time : (existing as any).reporting_time;
      const nextLeavingTime = rest.leaving_time !== undefined ? rest.leaving_time : (existing as any).leaving_time;
      if (!nextReportingTime || !nextLeavingTime) {
        throw new BadRequestException('Expected check-in and check-out times are required when payroll uses fixed times.');
      }
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

    let result: any;
    try {
      result = await this.prisma.$transaction(async (tx) => {
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

      const userId = account
        ? (await tx.users.create({ data: account.data, select: { id: true } })).id
        : rest.user_id !== undefined
          ? rest.user_id
          : undefined;

      return tx.employee_profiles.update({
        where: { id },
        data: {
          user_id: userId,
          cnic: rest.cnic !== undefined ? rest.cnic : undefined,
          join_date: rest.join_date !== undefined ? (rest.join_date ? new Date(rest.join_date) : null) : undefined,
          employment_type: rest.employment_type !== undefined ? rest.employment_type : undefined,
          department_id: rest.department_id !== undefined ? rest.department_id : undefined,
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
          secondary_phone: rest.secondary_phone !== undefined ? nullIfEmpty(rest.secondary_phone) : undefined,
          personal_email: rest.personal_email !== undefined ? nullIfEmpty(rest.personal_email) : undefined,
          job_title: rest.job_title !== undefined ? upperOrNull(rest.job_title) : undefined,
          staff_category_id: rest.staff_category_id !== undefined ? rest.staff_category_id : undefined,
          segment_id: rest.segment_id !== undefined ? rest.segment_id : undefined,
          job_description: rest.job_description !== undefined ? upperOrNull(rest.job_description) : undefined,
          notes: rest.notes !== undefined ? nullIfEmpty(rest.notes) : undefined,
          reporting_time: rest.reporting_time !== undefined ? toTime(rest.reporting_time ?? undefined) : undefined,
          leaving_time: rest.leaving_time !== undefined ? toTime(rest.leaving_time ?? undefined) : undefined,
          check_in_source: rest.check_in_source !== undefined ? rest.check_in_source : undefined,
          late_relaxation_minutes: rest.late_relaxation_minutes !== undefined ? rest.late_relaxation_minutes : undefined,
          monthly_pay: rest.monthly_pay !== undefined ? rest.monthly_pay : undefined,
          payroll_enabled: rest.payroll_enabled !== undefined ? rest.payroll_enabled : undefined,
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
    } catch (err) {
      const conflict = this.conflictFromUniqueViolation(err);
      if (conflict) throw conflict;
      throw err;
    }

    if (account) {
      this.auditLogs.log({
        entity_type: 'USER',
        entity_id: result.user_id,
        action: 'CREATED',
        section: 'system',
        new_value: `${account.data.username} (${account.data.role})`,
        changed_by: caller?.sub || changedBy || 'system',
        note: `Created user ${account.data.username} (#${result.user_id}) with role ${account.data.role}` +
          (account.data.campus_id ? `, campus #${account.data.campus_id}` : '') +
          (account.data.full_name ? `, name "${account.data.full_name}"` : '') +
          ` and linked it to employee #${id}.`,
      });
    }

    const trackedFields: Array<{ key: keyof typeof rest | 'employee_code_dep' | 'employee_code_number'; label: string; oldKey?: string }> = [
      { key: 'full_name', label: 'Full Name' },
      { key: 'employee_code', label: 'Code' },
      { key: 'employee_code_dep', label: 'Code Dept', oldKey: 'employee_code_dep' },
      { key: 'employee_code_number', label: 'Code Number', oldKey: 'employee_code_number' },
      { key: 'cnic', label: 'CNIC' },
      { key: 'job_title', label: 'Job Title' },
      { key: 'employment_type', label: 'Employment Type' },
      { key: 'department_id', label: 'Department' },
      { key: 'campus_id', label: 'Campus' },
      { key: 'personal_phone', label: 'Phone' },
      { key: 'secondary_phone', label: 'Secondary Phone' },
      { key: 'personal_email', label: 'Email' },
      { key: 'monthly_pay', label: 'Monthly Pay' },
      { key: 'payroll_enabled', label: 'On Payroll' },
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
    const record = await this.prisma.$transaction(async (tx) => {
      if (existing.user_id) {
        await tx.users.update({
          where: { id: existing.user_id },
          data: { is_active: false },
        });
      }
      return tx.employee_profiles.delete({
        where: { id },
      });
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
    const wasOffboarded =
      existing.employment_status === EmployeeStatus.TERMINATED ||
      existing.employment_status === EmployeeStatus.LEFT;
    const reactivatePortal =
      wasOffboarded &&
      (nextStatus === EmployeeStatus.ACTIVE ||
        nextStatus === EmployeeStatus.PERMANENT ||
        nextStatus === EmployeeStatus.FAMILY);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (existing.user_id && deactivatePortal) {
        await tx.users.update({
          where: { id: existing.user_id },
          data: { is_active: false },
        });
      } else if (existing.user_id && reactivatePortal) {
        await tx.users.update({
          where: { id: existing.user_id },
          data: { is_active: true },
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

  async updateWorkSchedule(employeeId: number, dto: UpdateWorkScheduleDto, caller?: IJwtStaffPayload) {
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

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const scheduleNote = dto.days
      .map((d) => `${dayNames[d.day_of_week]}${(d.is_working ?? true) ? '' : ' (off)'}`)
      .join(', ');
    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'UPDATED',
      section: 'hr',
      field: 'work_schedule',
      note: `${employee.full_name ?? `#${employeeId}`} — work schedule set: ${scheduleNote || 'none'}`,
      changed_by: caller?.username || caller?.sub || 'system',
    });

    return this.getWorkSchedule(employeeId);
  }

  async clearWorkSchedule(employeeId: number, caller?: IJwtStaffPayload) {
    const employee = await this.prisma.employee_profiles.findUnique({ where: { id: employeeId } });
    if (!employee) throw new NotFoundException(`Employee with ID ${employeeId} not found`);

    await this.prisma.employee_work_schedules.deleteMany({ where: { employee_id: employeeId } });

    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'UPDATED',
      section: 'hr',
      field: 'work_schedule',
      note: `${employee.full_name ?? `#${employeeId}`} — work schedule cleared`,
      changed_by: caller?.username || caller?.sub || 'system',
    });

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

    const existingUser = await this.prisma.users.findUnique({
      where: { id: employee.user_id },
      select: {
        email: true,
        role: true,
        campus_id: true,
        is_active: true,
        allowed_class_ids: true,
      },
    });

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

    const updated = await this.prisma.users.update({
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

    const changes: string[] = [];
    if (dto.email !== undefined && (existingUser?.email ?? null) !== (updated.email ?? null)) {
      changes.push(`email: ${existingUser?.email || '—'} → ${updated.email || '—'}`);
    }
    if (dto.role !== undefined && existingUser?.role !== updated.role) {
      changes.push(`role: ${existingUser?.role || '—'} → ${updated.role || '—'}`);
    }
    if (dto.campus_id !== undefined && (existingUser?.campus_id ?? null) !== (updated.campus_id ?? null)) {
      changes.push(`campus: ${existingUser?.campus_id ?? '—'} → ${updated.campus_id ?? '—'}`);
    }
    if (dto.is_active !== undefined && existingUser?.is_active !== updated.is_active) {
      changes.push(`active: ${existingUser?.is_active} → ${updated.is_active}`);
    }
    if (dto.allowed_class_ids !== undefined) {
      const oldBand = JSON.stringify(existingUser?.allowed_class_ids ?? []);
      const newBand = JSON.stringify(updated.allowed_class_ids ?? []);
      if (oldBand !== newBand) {
        changes.push(`class-band: ${oldBand} → ${newBand}`);
      }
    }

    if (changes.length > 0) {
      this.auditLogs.log({
        entity_type: 'EMPLOYEE',
        entity_id: String(employeeId),
        action: 'UPDATED',
        section: 'hr',
        note: `${(employee as any).full_name ?? `#${employeeId}`} account — ${changes.join(' | ')}`,
        changed_by: caller.username || caller.sub || 'system',
      });
    }

    return updated;
  }

  async resetAccountPassword(
    employeeId: number,
    dto: ResetEmployeePasswordDto,
    caller?: IJwtStaffPayload,
  ) {
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
      data: { password_hash, password_reveal: encryptSecret(dto.password) },
    });

    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'UPDATED',
      section: 'hr',
      field: 'password',
      note: `${(employee as any).full_name ?? `#${employeeId}`} — portal password reset`,
      changed_by: caller?.username || caller?.sub || 'system',
    });

    return { success: true };
  }

  async revealAccountPassword(employeeId: number, caller?: IJwtStaffPayload) {
    const employee = await this.findOne(employeeId);
    if (!employee.user_id) {
      throw new BadRequestException('This employee has no linked portal account.');
    }

    const user = await this.prisma.users.findUnique({
      where: { id: employee.user_id },
      select: { username: true, password_reveal: true },
    });
    if (!user) throw new NotFoundException('Linked portal account not found.');
    if (!user.password_reveal) {
      throw new BadRequestException('No recoverable password on file for this account — reset the password to set one.');
    }

    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'UPDATED',
      section: 'hr',
      field: 'password',
      note: `${(employee as any).full_name ?? `#${employeeId}`} — portal password revealed`,
      changed_by: caller?.username || caller?.sub || 'system',
    });

    return { username: user.username, password: decryptSecret(user.password_reveal) };
  }

  async changeAccountUsername(employeeId: number, dto: ChangeEmployeeUsernameDto, caller?: IJwtStaffPayload) {
    const employee = await this.findOne(employeeId);
    if (!employee.user_id) {
      throw new BadRequestException('This employee has no linked portal account.');
    }

    const nextUsername = dto.username.trim();
    if (isLegacyTafsEmailUsername(nextUsername)) {
      throw new BadRequestException('Usernames may no longer use the "@tafs.com" format — use a "name1.name2.name3" style username instead.');
    }
    if (!/^[a-z0-9._-]+$/i.test(nextUsername)) {
      throw new BadRequestException('Username may only contain letters, numbers, dots, underscores and hyphens.');
    }

    const existingUser = await this.prisma.users.findUnique({
      where: { id: employee.user_id },
      select: { username: true },
    });

    const conflict = await this.prisma.users.findFirst({
      where: { username: nextUsername, NOT: { id: employee.user_id } },
    });
    if (conflict) throw new ConflictException('Username already taken.');

    const updated = await this.prisma.users.update({
      where: { id: employee.user_id },
      data: { username: nextUsername },
      select: { id: true, username: true },
    });

    this.auditLogs.log({
      entity_type: 'EMPLOYEE',
      entity_id: String(employeeId),
      action: 'UPDATED',
      section: 'hr',
      field: 'username',
      old_value: existingUser?.username,
      new_value: updated.username,
      note: `${(employee as any).full_name ?? `#${employeeId}`} — portal username changed from "${existingUser?.username}" to "${updated.username}"`,
      changed_by: caller?.username || caller?.sub || 'system',
    });

    return updated;
  }
}
