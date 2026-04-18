import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { SetPermissionDto } from './dto/set-permission.dto';
import { UpdateRolePermissionDto } from './dto/update-role-permission.dto';
import { v4 as uuidv4 } from 'uuid';
import { StaffRole } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  // ─── Auth helpers ────────────────────────────────────────────────────────────

  async findStaffByUsername(username: string) {
    return this.prisma.users.findUnique({
      where: { username },
      include: { campuses: true },
    });
  }

  async findParentByUsername(username: string) {
    return this.prisma.families.findFirst({
      where: { email: username },
      select: {
        id: true,
        email: true,
        household_name: true,
        password_hash: true,
      },
    });
  }

  // ─── User CRUD ──────────────────────────────────────────────────────────────

  async listUsers() {
    return this.prisma.users.findMany({
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        username: true,
        full_name: true,
        role: true,
        campus_id: true,
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
      },
    });
  }

  async findUserById(id: string) {
    const user = await this.prisma.users.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        full_name: true,
        role: true,
        campus_id: true,
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
      },
    });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  async createUser(dto: CreateUserDto, createdById: string) {
    const existing = await this.prisma.users.findUnique({
      where: { username: dto.username },
    });
    if (existing) throw new ConflictException('Username already taken');

    const hash = await bcrypt.hash(dto.password, 10);
    const now = new Date();

    return this.prisma.users.create({
      data: {
        id: uuidv4(),
        username: dto.username,
        full_name: dto.full_name,
        password_hash: hash,
        role: dto.role,
        campus_id: dto.campus_id ? Number(dto.campus_id) : null,
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
        is_active: true,
        created_at: true,
        campuses: { select: { campus_name: true } },
      },
    });
  }

  async updateUser(id: string, dto: UpdateUserDto) {
    await this.findUserById(id); // ensures existence

    const data: any = { updated_at: new Date() };
    if (dto.full_name !== undefined) data.full_name = dto.full_name;
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.campus_id !== undefined) data.campus_id = dto.campus_id ? Number(dto.campus_id) : null;
    if (dto.is_active !== undefined) data.is_active = dto.is_active;
    if (dto.password) data.password_hash = await bcrypt.hash(dto.password, 10);

    return this.prisma.users.update({
      where: { id },
      data,
      select: {
        id: true,
        username: true,
        full_name: true,
        role: true,
        campus_id: true,
        is_active: true,
        updated_at: true,
        campuses: { select: { campus_name: true } },
      },
    });
  }

  async deactivateUser(id: string) {
    await this.findUserById(id);
    return this.prisma.users.update({
      where: { id },
      data: { is_active: false, updated_at: new Date() },
    });
  }

  async reactivateUser(id: string) {
    await this.findUserById(id);
    return this.prisma.users.update({
      where: { id },
      data: { is_active: true, updated_at: new Date() },
    });
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

  async setPermission(userId: string, dto: SetPermissionDto, grantedById: string) {
    const permission = await this.prisma.permissions.findUnique({
      where: { key: dto.permission_key },
    });
    if (!permission) throw new NotFoundException(`Permission key "${dto.permission_key}" not found`);

    await this.findUserById(userId);

    return this.prisma.user_permissions.upsert({
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
  }

  async removePermissionOverride(userId: string, permissionKey: string) {
    const permission = await this.prisma.permissions.findUnique({
      where: { key: permissionKey },
    });
    if (!permission) throw new NotFoundException(`Permission key "${permissionKey}" not found`);

    await this.prisma.user_permissions.deleteMany({
      where: { user_id: userId, permission_id: permission.id },
    });

    return { removed: true };
  }

  async listRolePermissions(role: StaffRole) {
    return this.prisma.role_permissions.findMany({
      where: { role },
      select: { permission_id: true },
    });
  }

  async updateRolePermission(dto: UpdateRolePermissionDto) {
    if (dto.granted) {
      return this.prisma.role_permissions.upsert({
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
    } else {
      return this.prisma.role_permissions.deleteMany({
        where: {
          role: dto.role,
          permission_id: dto.permission_id,
        },
      });
    }
  }
}
