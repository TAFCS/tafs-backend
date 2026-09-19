import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ScopeService } from '../../common/scope/scope.service';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { SetPermissionDto } from './dto/set-permission.dto';
import { UpdateRolePermissionDto } from './dto/update-role-permission.dto';
import { v4 as uuidv4 } from 'uuid';
import { StaffRole } from '@prisma/client';
import { encryptSecret, decryptSecret } from '../../common/utils/reversible-secret.util';
import { isLegacyTafsEmailUsername } from '../../common/utils/account-credentials.util';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import {
  PEOPLE_ACCESS_TILE_ID,
  USER_FIELD_TAB_MAP,
  USER_SUPER_ADMIN_ONLY_FIELDS,
} from './user-field-tabs';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private auditLogs: AuditLogsService,
    private scope: ScopeService,
  ) {}

  /**
   * Scope where-fragment for a query over `users`. A user's dimensions come
   * from their linked employee_profile when one exists (campus/segment/
   * department/staff_category); accounts with no profile fall back to the
   * legacy `users.campus_id` field on campus only, since that's the only
   * dimension they carry. Campus never ORs both fields together — that could
   * re-admit someone whose real (profile) campus is out of scope via a stale
   * legacy value — it's profile-if-present, else the legacy field.
   */
  private whereForUsers(actingUser?: IJwtStaffPayload): Prisma.usersWhereInput {
    if (!actingUser || this.scope.isExempt(actingUser)) return {};
    const scope = this.scope.scopeOf(actingUser);
    const clauses: Prisma.usersWhereInput[] = [];

    if (scope.campuses.length > 0) {
      clauses.push({
        OR: [
          { employee_profile: { campus_id: { in: scope.campuses } } },
          { employee_profile: null, campus_id: { in: scope.campuses } },
        ],
      });
    }
    if (scope.segments.length > 0) {
      clauses.push({ employee_profile: { segment_id: { in: scope.segments } } });
    }
    if (scope.departments.length > 0) {
      clauses.push({ employee_profile: { department_id: { in: scope.departments } } });
    }
    if (scope.staffCategories.length > 0) {
      clauses.push({ employee_profile: { staff_category_id: { in: scope.staffCategories } } });
    }
    return clauses.length > 0 ? { AND: clauses } : {};
  }

  /** Non-throwing counterpart, for turning a 403 into a 404 on `:id` lookups. */
  private canSeeUser(
    actingUser: IJwtStaffPayload | undefined,
    target: {
      campus_id: number | null;
      employee_profile?: {
        campus_id: number | null;
        segment_id: number | null;
        department_id: number | null;
        staff_category_id: number | null;
      } | null;
    },
  ): boolean {
    if (!actingUser || this.scope.isExempt(actingUser)) return true;
    return this.scope.canSeeEmployee(actingUser, {
      campus_id: target.employee_profile ? target.employee_profile.campus_id : target.campus_id,
      segment_id: target.employee_profile?.segment_id ?? null,
      department_id: target.employee_profile?.department_id ?? null,
      staff_category_id: target.employee_profile?.staff_category_id ?? null,
    });
  }

  /**
   * Authorises an edit field by field against `<tab>.edit`, mirroring
   * EmployeesService.assertFieldsEditable. `role` is excluded from the
   * generic map on purpose — see USER_SUPER_ADMIN_ONLY_FIELDS — and checked
   * directly against the actor's own role instead.
   *
   * A caller whose session predates sub-permissions (no `actions`) is left
   * alone: the coarse CASL check already gated them, and failing closed here
   * would lock out every open session for 90 days until their token rotates.
   * The route-level @RequireAction is the boundary that does fail closed.
   */
  private assertFieldsEditable(dto: UpdateUserDto, actingUser?: IJwtStaffPayload) {
    if (USER_SUPER_ADMIN_ONLY_FIELDS.some((f) => (dto as Record<string, unknown>)[f] !== undefined)) {
      if (!actingUser || actingUser.role !== StaffRole.SUPER_ADMIN) {
        throw new ForbiddenException('Only a super admin may change a user\'s role.');
      }
    }

    if (!actingUser || actingUser.role === StaffRole.SUPER_ADMIN) return;
    if (actingUser.actions === undefined) return;

    const held = new Set(actingUser.actions);
    const denied = Object.entries(dto)
      .filter(([field, v]) => v !== undefined && !USER_SUPER_ADMIN_ONLY_FIELDS.includes(field))
      .map(([field]) => field)
      .filter((field) => {
        const tab = USER_FIELD_TAB_MAP[field];
        if (!tab) return false;
        return !held.has(`${PEOPLE_ACCESS_TILE_ID}#${tab}.edit`);
      });

    if (denied.length > 0) {
      throw new ForbiddenException(
        `You do not have permission to edit: ${denied.join(', ')}.`,
      );
    }
  }

  // ─── Auth helpers ────────────────────────────────────────────────────────────

  async findStaffByUsername(username: string) {
    return this.prisma.users.findUnique({
      where: { username },
      include: { campuses: true },
    });
  }

  async findParentByUsername(username: string) {
    return this.prisma.families.findFirst({
      where: { email: username, deleted_at: null, password_hash: { not: null } },
      select: {
        id: true,
        email: true,
        household_name: true,
        password_hash: true,
      },
    });
  }

  // ─── User CRUD ──────────────────────────────────────────────────────────────

  async isUsernameAvailable(username: string): Promise<boolean> {
    const trimmed = username.trim();
    if (!trimmed) return false;
    const existing = await this.prisma.users.findFirst({
      where: { username: { equals: trimmed, mode: 'insensitive' } },
      select: { id: true },
    });
    return !existing;
  }

  async listUsers(actingUser?: IJwtStaffPayload) {
    return this.prisma.users.findMany({
      where: this.whereForUsers(actingUser),
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        username: true,
        full_name: true,
        role: true,
        campus_id: true,
        allowed_class_ids: true,
        is_active: true,
        created_at: true,
        campuses: {
          select: { campus_name: true },
        },
        user_permissions: {
          select: {
            id: true,
            granted: true,
            permissions: { select: { key: true } },
          },
        },
        employee_profile: {
          select: {
            id: true,
            campus_id: true,
            department_id: true,
            staff_category_id: true,
            job_title: true,
            reporting_manager_id: true,
            join_date: true,
            monthly_pay: true,
            payroll_enabled: true,
            campuses: { select: { campus_name: true } },
            departments: { select: { id: true, name: true } },
            staff_categories: { select: { id: true, name: true, code: true } },
            reporting_manager: { select: { id: true, full_name: true } },
          },
        },
      },
    });
  }

  async findUserById(id: string, actingUser?: IJwtStaffPayload) {
    const user = await this.prisma.users.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        full_name: true,
        role: true,
        campus_id: true,
        allowed_class_ids: true,
        is_active: true,
        created_at: true,
        campuses: { select: { campus_name: true } },
        user_permissions: {
          select: {
            id: true,
            granted: true,
            note: true,
            granted_at: true,
            permissions: { select: { key: true, module: true, description: true } },
          },
        },
        employee_profile: {
          select: {
            id: true,
            campus_id: true,
            segment_id: true,
            department_id: true,
            staff_category_id: true,
            job_title: true,
            reporting_manager_id: true,
            join_date: true,
            monthly_pay: true,
            payroll_enabled: true,
            campuses: { select: { campus_name: true } },
            departments: { select: { id: true, name: true } },
            staff_categories: { select: { id: true, name: true, code: true } },
            reporting_manager: { select: { id: true, full_name: true } },
          },
        },
      },
    });
    // Missing and out-of-scope both 404 — a 403 here would confirm a real id
    // exists outside the caller's scope and turn the route into an enumerator.
    if (!user || !this.canSeeUser(actingUser, user)) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  async revealPassword(id: string, revealedBy: string, actingUser?: IJwtStaffPayload) {
    await this.findUserById(id, actingUser);
    const user = await this.prisma.users.findUnique({
      where: { id },
      select: { username: true, password_reveal: true },
    });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    if (!user.password_reveal) {
      throw new BadRequestException('No recoverable password on file for this account — set a new password first.');
    }

    this.auditLogs.log({
      entity_type: 'USER',
      entity_id: id,
      action: 'UPDATED',
      section: 'system',
      field: 'password',
      changed_by: revealedBy,
      note: `Password revealed for user ${user.username} (#${id}).`,
    });

    return { username: user.username, password: decryptSecret(user.password_reveal) };
  }

  async createUser(dto: CreateUserDto, createdById: string, actingUser?: IJwtStaffPayload) {
    if (isLegacyTafsEmailUsername(dto.username)) {
      throw new BadRequestException('Usernames may no longer use the "@tafs.com" format — use a "name1.name2.name3" style username instead.');
    }

    const existing = await this.prisma.users.findUnique({
      where: { username: dto.username },
    });
    if (existing) throw new ConflictException('Username already taken');

    // Assert the TARGET campus is in scope, or a scoped admin could create a
    // login reaching outside their own scope.
    if (actingUser) {
      this.scope.assertCampus(actingUser, dto.campus_id ? Number(dto.campus_id) : null);
    }

    const hash = await bcrypt.hash(dto.password, 10);
    const now = new Date();

    const record = await this.prisma.users.create({
      data: {
        id: uuidv4(),
        username: dto.username,
        full_name: dto.full_name,
        password_hash: hash,
        password_reveal: encryptSecret(dto.password),
        role: dto.role,
        campus_id: dto.campus_id ? Number(dto.campus_id) : null,
        allowed_class_ids: dto.allowed_class_ids ?? [],
        is_active: true,
        created_at: now,
        updated_at: now,
      },
      select: {
        id: true,
        username: true,
        full_name: true,
        role: true,
        campus_id: true,
        allowed_class_ids: true,
        is_active: true,
        created_at: true,
        campuses: { select: { campus_name: true } },
      },
    });
    this.auditLogs.log({
      entity_type: 'USER',
      entity_id: record.id,
      action: 'CREATED',
      section: 'system',
      new_value: `${dto.username} (${dto.role})`,
      changed_by: createdById,
      note: `Created user ${dto.username} (#${record.id}) with role ${dto.role}` +
        (dto.campus_id ? `, campus #${dto.campus_id}` : '') +
        (dto.full_name ? `, name "${dto.full_name}"` : '') + '.',
    });
    return record;
  }

  async updateUser(id: string, dto: UpdateUserDto, changedBy?: string, actingUser?: IJwtStaffPayload) {
    const existing = await this.findUserById(id, actingUser);
    this.assertFieldsEditable(dto, actingUser);
    // Assert the TARGET campus is in scope too, or a scoped admin could move
    // a user's campus outside their own reach.
    if (dto.campus_id !== undefined && actingUser) {
      this.scope.assertCampus(actingUser, dto.campus_id ? Number(dto.campus_id) : null);
    }

    const data: any = { updated_at: new Date() };
    if (dto.full_name !== undefined) data.full_name = dto.full_name;
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.campus_id !== undefined) data.campus_id = dto.campus_id ? Number(dto.campus_id) : null;
    if (dto.allowed_class_ids !== undefined) data.allowed_class_ids = dto.allowed_class_ids;
    if (dto.is_active !== undefined) data.is_active = dto.is_active;
    if (dto.password) {
      data.password_hash = await bcrypt.hash(dto.password, 10);
      data.password_reveal = encryptSecret(dto.password);
    }

    const record = await this.prisma.users.update({
      where: { id },
      data,
      select: {
        id: true,
        username: true,
        full_name: true,
        role: true,
        campus_id: true,
        allowed_class_ids: true,
        is_active: true,
        updated_at: true,
        campuses: { select: { campus_name: true } },
      },
    });

    const changes: string[] = [];
    if (dto.full_name !== undefined && existing.full_name !== record.full_name) {
      changes.push(`full_name "${existing.full_name ?? '—'}" → "${record.full_name ?? '—'}"`);
    }
    if (dto.role !== undefined && existing.role !== record.role) {
      changes.push(`role ${existing.role} → ${record.role}`);
    }
    if (dto.campus_id !== undefined && existing.campus_id !== record.campus_id) {
      changes.push(`campus_id ${existing.campus_id ?? '—'} → ${record.campus_id ?? '—'}`);
    }
    if (dto.allowed_class_ids !== undefined) {
      const before = JSON.stringify(existing.allowed_class_ids ?? []);
      const after = JSON.stringify(record.allowed_class_ids ?? []);
      if (before !== after) {
        changes.push(`allowed_class_ids ${before} → ${after}`);
      }
    }
    if (dto.is_active !== undefined && existing.is_active !== record.is_active) {
      changes.push(`is_active ${existing.is_active} → ${record.is_active}`);
    }
    if (dto.password) {
      changes.push('password changed');
    }

    await this.auditLogs.log({
      entity_type: 'USER',
      entity_id: id,
      action: dto.role !== undefined && existing.role !== record.role ? 'ROLE_CHANGED' : 'UPDATED',
      section: 'system',
      field: dto.role !== undefined && existing.role !== record.role ? 'role' : null,
      old_value: dto.role !== undefined && existing.role !== record.role ? existing.role : existing.username,
      new_value: dto.role !== undefined && existing.role !== record.role ? record.role : record.username,
      changed_by: changedBy ?? 'system',
      note: changes.length > 0
        ? `User ${existing.username} (#${id}) updated: ${changes.join(', ')}.`
        : `User ${existing.username} (#${id}) update submitted with no effective changes.`,
    });
    return record;
  }

  async deactivateUser(id: string, changedBy?: string) {
    const existing = await this.findUserById(id);
    const record = await this.prisma.users.update({
      where: { id },
      data: { is_active: false, updated_at: new Date() },
    });
    await this.auditLogs.log({
      entity_type: 'USER',
      entity_id: id,
      action: 'UPDATED',
      section: 'system',
      field: 'is_active',
      old_value: 'true',
      new_value: 'false',
      changed_by: changedBy ?? 'system',
      note: `User ${existing.username} (#${id}) deactivated.`,
    });
    return record;
  }

  async reactivateUser(id: string, changedBy?: string) {
    const existing = await this.findUserById(id);
    const record = await this.prisma.users.update({
      where: { id },
      data: { is_active: true, updated_at: new Date() },
    });
    await this.auditLogs.log({
      entity_type: 'USER',
      entity_id: id,
      action: 'UPDATED',
      section: 'system',
      field: 'is_active',
      old_value: 'false',
      new_value: 'true',
      changed_by: changedBy ?? 'system',
      note: `User ${existing.username} (#${id}) reactivated.`,
    });
    return record;
  }

  // ─── Permission Management ───────────────────────────────────────────────────

  async listAllPermissions() {
    return this.prisma.permissions.findMany({
      orderBy: [{ module: 'asc' }, { key: 'asc' }],
    });
  }

  async getUserPermissionState(userId: string, role: string) {
    // Get all permissions
    const allPermissions = await this.prisma.permissions.findMany({
      orderBy: [{ module: 'asc' }, { key: 'asc' }],
    });

    // Get role defaults
    const roleDefaults = await this.prisma.role_permissions.findMany({
      where: { role: role as StaffRole },
      select: { permission_id: true },
    });
    const roleDefaultSet = new Set(roleDefaults.map((rp) => rp.permission_id));

    // Get user overrides
    const userOverrides = await this.prisma.user_permissions.findMany({
      where: { user_id: userId },
      select: { permission_id: true, granted: true, note: true, granted_at: true },
    });
    const overridesMap = new Map<number, any>(
      userOverrides.map((uo) => [uo.permission_id, uo]),
    );

    return allPermissions.map((perm) => {
      const hasRoleDefault = roleDefaultSet.has(perm.id);
      const override = overridesMap.get(perm.id);
      let effectiveGranted: boolean;
      let source: 'role' | 'override_grant' | 'override_revoke' | 'denied';

      if (override !== undefined) {
        effectiveGranted = override.granted;
        source = override.granted ? 'override_grant' : 'override_revoke';
      } else if (hasRoleDefault) {
        effectiveGranted = true;
        source = 'role';
      } else {
        effectiveGranted = false;
        source = 'denied';
      }

      return {
        permission_id: perm.id,
        key: perm.key,
        module: perm.module,
        description: perm.description,
        role_default: hasRoleDefault,
        has_override: override !== undefined,
        override_granted: override?.granted ?? null,
        effective: effectiveGranted,
        source,
        note: override?.note ?? null,
        override_at: override?.granted_at ?? null,
      };
    });
  }

  async setPermission(userId: string, dto: SetPermissionDto, grantedById: string, changedBy?: string) {
    const permission = await this.prisma.permissions.findUnique({
      where: { key: dto.permission_key },
    });
    if (!permission) throw new NotFoundException(`Permission key "${dto.permission_key}" not found`);

    const user = await this.findUserById(userId);
    const existing = await this.prisma.user_permissions.findUnique({
      where: {
        user_id_permission_id: {
          user_id: userId,
          permission_id: permission.id,
        },
      },
    });

    const result = await this.prisma.user_permissions.upsert({
      where: {
        user_id_permission_id: {
          user_id: userId,
          permission_id: permission.id,
        },
      },
      update: {
        granted: dto.granted,
        granted_by: grantedById,
        granted_at: new Date(),
        note: dto.note ?? null,
      },
      create: {
        user_id: userId,
        permission_id: permission.id,
        granted: dto.granted,
        granted_by: grantedById,
        granted_at: new Date(),
        note: dto.note ?? null,
      },
    });

    await this.auditLogs.log({
      entity_type: 'PERMISSION',
      entity_id: `${userId}:${dto.permission_key}`,
      action: existing ? 'UPDATED' : 'CREATED',
      section: 'system',
      field: 'user_permission_override',
      old_value: existing ? String(existing.granted) : null,
      new_value: String(dto.granted),
      changed_by: changedBy ?? grantedById,
      note: `Permission override "${dto.permission_key}" for user ${user.username} (#${userId}): ` +
        (existing ? `granted ${existing.granted} → ${dto.granted}` : `set granted=${dto.granted}`) +
        (dto.note ? ` (note: ${dto.note})` : '') + '.',
    });

    return result;
  }

  async removePermissionOverride(userId: string, permissionKey: string, changedBy?: string) {
    const permission = await this.prisma.permissions.findUnique({
      where: { key: permissionKey },
    });
    if (!permission) throw new NotFoundException(`Permission key "${permissionKey}" not found`);

    const user = await this.findUserById(userId);
    const existing = await this.prisma.user_permissions.findUnique({
      where: {
        user_id_permission_id: {
          user_id: userId,
          permission_id: permission.id,
        },
      },
    });

    await this.prisma.user_permissions.deleteMany({
      where: { user_id: userId, permission_id: permission.id },
    });

    if (existing) {
      await this.auditLogs.log({
        entity_type: 'PERMISSION',
        entity_id: `${userId}:${permissionKey}`,
        action: 'DELETED',
        section: 'system',
        field: 'user_permission_override',
        old_value: String(existing.granted),
        new_value: null,
        changed_by: changedBy ?? 'system',
        note: `Removed permission override "${permissionKey}" (was granted=${existing.granted}) for user ${user.username} (#${userId}); role defaults apply again.`,
      });
    }

    return { removed: true };
  }

  async listRolePermissions(role: StaffRole) {
    return this.prisma.role_permissions.findMany({
      where: { role },
      select: { permission_id: true },
    });
  }

  async updateRolePermission(dto: UpdateRolePermissionDto, changedBy?: string) {
    const permission = await this.prisma.permissions.findUnique({
      where: { id: dto.permission_id },
      select: { id: true, key: true },
    });
    if (!permission) throw new NotFoundException(`Permission id ${dto.permission_id} not found`);

    const existing = await this.prisma.role_permissions.findUnique({
      where: {
        role_permission_id: {
          role: dto.role,
          permission_id: dto.permission_id,
        },
      },
    });

    if (dto.granted) {
      const result = await this.prisma.role_permissions.upsert({
        where: {
          role_permission_id: {
            role: dto.role,
            permission_id: dto.permission_id,
          },
        },
        update: {},
        create: {
          role: dto.role,
          permission_id: dto.permission_id,
        },
      });

      if (!existing) {
        await this.auditLogs.log({
          entity_type: 'PERMISSION',
          entity_id: `${dto.role}:${permission.key}`,
          action: 'CREATED',
          section: 'system',
          field: 'role_permission',
          new_value: permission.key,
          changed_by: changedBy ?? 'system',
          note: `Granted role-default permission "${permission.key}" to role ${dto.role}.`,
        });
      }

      return result;
    } else {
      const result = await this.prisma.role_permissions.deleteMany({
        where: {
          role: dto.role,
          permission_id: dto.permission_id,
        },
      });

      if (existing) {
        await this.auditLogs.log({
          entity_type: 'PERMISSION',
          entity_id: `${dto.role}:${permission.key}`,
          action: 'DELETED',
          section: 'system',
          field: 'role_permission',
          old_value: permission.key,
          changed_by: changedBy ?? 'system',
          note: `Revoked role-default permission "${permission.key}" from role ${dto.role}.`,
        });
      }

      return result;
    }
  }
}
