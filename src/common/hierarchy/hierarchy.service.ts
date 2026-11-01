import { Injectable, Logger } from '@nestjs/common';
import { EmployeeStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { readUntilMigrated } from '../../utils/pending-migration.util';
import type { BelowOptions, HierarchyMode } from './hierarchy.types';

export const HIERARCHY_CONFIG_PREFIX = 'hierarchy.';
export const LEGACY_ENFORCE_KEY = 'enforce_reporting_hierarchy';

interface CachedLines {
  lines: { employee_id: number; manager_id: number }[];
  expires: number;
}

interface CachedEmpUserMapping {
  empToUser: Map<number, string>;
  userToEmp: Map<string, number>;
  expires: number;
}

@Injectable()
export class HierarchyService {
  private readonly logger = new Logger(HierarchyService.name);

  private linesCache: CachedLines | null = null;
  private empUserCache: CachedEmpUserMapping | null = null;
  private modeCache = new Map<string, { mode: HierarchyMode; expires: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Super admins and developers stand outside the hierarchy and have unrestricted authority.
   */
  isExempt(user: { role?: string } | null | undefined): boolean {
    return user?.role === 'SUPER_ADMIN' || user?.role === 'DEVELOPER';
  }

  /**
   * Returns employee IDs under this person at any depth (or bounded by options.depth).
   * Safe with cycles and multiple managers. Excludes the caller and all superiors.
   */
  async below(userId: string, options?: BelowOptions): Promise<number[]> {
    const callerEmpId = await this.getEmployeeIdForUser(userId);
    if (!callerEmpId) return [];

    const lines = await this.getReportingLines();
    if (lines.length === 0) return [];

    // Build manager -> subordinates adjacency and employee -> managers adjacency
    const childrenOf = new Map<number, number[]>();
    const parentsOf = new Map<number, number[]>();

    for (const line of lines) {
      const children = childrenOf.get(line.manager_id) ?? [];
      children.push(line.employee_id);
      childrenOf.set(line.manager_id, children);

      const parents = parentsOf.get(line.employee_id) ?? [];
      parents.push(line.manager_id);
      parentsOf.set(line.employee_id, parents);
    }

    // Identify ancestors of caller (superiors) to ensure cycles never treat superiors as subordinates
    const ancestors = new Set<number>();
    const upQueue: number[] = [callerEmpId];
    while (upQueue.length > 0) {
      const current = upQueue.shift()!;
      const managers = parentsOf.get(current) ?? [];
      for (const m of managers) {
        if (!ancestors.has(m) && m !== callerEmpId) {
          ancestors.add(m);
          upQueue.push(m);
        }
      }
    }

    // BFS downwards
    const subordinates: number[] = [];
    const visited = new Set<number>([callerEmpId]);
    const queue: { id: number; depth: number }[] = [{ id: callerEmpId, depth: 0 }];
    const maxDepth = options?.depth;

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (maxDepth != null && depth >= maxDepth) {
        continue;
      }

      const children = childrenOf.get(id) ?? [];
      for (const childId of children) {
        if (!visited.has(childId) && !ancestors.has(childId) && childId !== callerEmpId) {
          visited.add(childId);
          subordinates.push(childId);
          queue.push({ id: childId, depth: depth + 1 });
        }
      }
    }

    return subordinates;
  }

  /**
   * Returns user IDs of subordinates under this person (login accounts linked via employee_profiles.user_id).
   */
  async userIdsBelow(userId: string, options?: BelowOptions): Promise<string[]> {
    const empIds = await this.below(userId, options);
    if (empIds.length === 0) return [];

    const { empToUser } = await this.getEmpUserMappings();
    const result: string[] = [];
    for (const empId of empIds) {
      const uid = empToUser.get(empId);
      if (uid) {
        result.push(uid);
      }
    }
    return result;
  }

  /**
   * Returns employee IDs of managers above this person in the hierarchy (all ancestors).
   */
  async above(userId: string): Promise<number[]> {
    const callerEmpId = await this.getEmployeeIdForUser(userId);
    if (!callerEmpId) return [];

    const lines = await this.getReportingLines();
    const parentsOf = new Map<number, number[]>();
    for (const line of lines) {
      const parents = parentsOf.get(line.employee_id) ?? [];
      parents.push(line.manager_id);
      parentsOf.set(line.employee_id, parents);
    }

    const managers: number[] = [];
    const visited = new Set<number>([callerEmpId]);
    const queue: number[] = [callerEmpId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const parents = parentsOf.get(current) ?? [];
      for (const p of parents) {
        if (!visited.has(p)) {
          visited.add(p);
          managers.push(p);
          queue.push(p);
        }
      }
    }

    return managers;
  }

  /**
   * Checks whether targetEmployeeId is below actorUserId in the reporting hierarchy.
   */
  async isBelow(actorUserId: string, targetEmployeeId: number): Promise<boolean> {
    const subs = await this.below(actorUserId);
    return subs.includes(targetEmployeeId);
  }

  /**
   * Reads mode for a feature ('off' | 'view' | 'enforce') from app_config ('hierarchy.<feature>').
   * Cached for 30 seconds.
   */
  async mode(feature: string): Promise<HierarchyMode> {
    const now = Date.now();
    const cached = this.modeCache.get(feature);
    if (cached && cached.expires > now) {
      return cached.mode;
    }

    if (!this.prisma?.app_config?.findUnique) {
      return 'off';
    }

    const key = `${HIERARCHY_CONFIG_PREFIX}${feature}`;
    const row = await readUntilMigrated(
      () => this.prisma.app_config.findUnique({ where: { key } }),
      null,
    );

    let mode: HierarchyMode = 'off';
    if (row?.value === 'enforce' || row?.value === 'true' || row?.value === '1') {
      mode = 'enforce';
    } else if (row?.value === 'view') {
      mode = 'view';
    } else if (row?.value === 'off' || row?.value === 'false' || row?.value === '0') {
      mode = 'off';
    } else if (feature === 'attendance') {
      // Fallback to legacy key if hierarchy.attendance not explicitly set
      const legacy = await readUntilMigrated(
        () => this.prisma.app_config.findUnique({ where: { key: LEGACY_ENFORCE_KEY } }),
        null,
      );
      if (legacy?.value === 'true' || legacy?.value === '1' || legacy?.value === 'enforce') {
        mode = 'enforce';
      }
    }

    this.modeCache.set(feature, { mode, expires: now + 30_000 });
    return mode;
  }

  /**
   * Sets mode for a feature in app_config and invalidates cache.
   */
  async setMode(feature: string, mode: HierarchyMode, updatedBy?: string): Promise<void> {
    const key = `${HIERARCHY_CONFIG_PREFIX}${feature}`;
    await readUntilMigrated(
      () =>
        this.prisma.app_config.upsert({
          where: { key },
          create: {
            key,
            value: mode,
            description: `Reporting hierarchy mode for ${feature} (TAFSD-328)`,
            updated_by: updatedBy ?? 'system',
          },
          update: {
            value: mode,
            updated_by: updatedBy ?? 'system',
          },
        }),
      null,
    );

    if (feature === 'attendance') {
      // Keep legacy enforce key in sync
      await readUntilMigrated(
        () =>
          this.prisma.app_config.upsert({
            where: { key: LEGACY_ENFORCE_KEY },
            create: {
              key: LEGACY_ENFORCE_KEY,
              value: mode === 'enforce' ? 'true' : 'false',
              description: 'Enforce reporting hierarchy on employee actions and attendance (TAFSD-328)',
              updated_by: updatedBy ?? 'system',
            },
            update: {
              value: mode === 'enforce' ? 'true' : 'false',
              updated_by: updatedBy ?? 'system',
            },
          }),
        null,
      );
    }

    this.modeCache.delete(feature);
  }

  /**
   * Invalidate all in-memory caches. Call whenever reporting lines are created/updated.
   */
  invalidateCache(): void {
    this.linesCache = null;
    this.empUserCache = null;
    this.modeCache.clear();
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private async getEmployeeIdForUser(userId: string): Promise<number | null> {
    const { userToEmp } = await this.getEmpUserMappings();
    if (userToEmp.has(userId)) {
      return userToEmp.get(userId)!;
    }

    if (!this.prisma?.employee_profiles?.findUnique) {
      return null;
    }

    const caller = await readUntilMigrated(
      () =>
        this.prisma.employee_profiles.findUnique({
          where: { user_id: userId },
          select: { id: true, employment_status: true },
        }),
      null,
    );

    if (!caller || caller.employment_status !== EmployeeStatus.ACTIVE) {
      return null;
    }
    userToEmp.set(userId, caller.id);
    return caller.id;
  }

  private async getReportingLines(): Promise<{ employee_id: number; manager_id: number }[]> {
    const now = Date.now();
    if (this.linesCache && this.linesCache.expires > now) {
      return this.linesCache.lines;
    }

    if (!this.prisma?.employee_reporting_lines?.findMany) {
      return [];
    }

    const lines = await readUntilMigrated(
      () =>
        this.prisma.employee_reporting_lines.findMany({
          where: {
            employee: { employment_status: EmployeeStatus.ACTIVE },
            manager: { employment_status: EmployeeStatus.ACTIVE },
          },
          select: { employee_id: true, manager_id: true },
        }),
      [] as { employee_id: number; manager_id: number }[],
    );

    this.linesCache = { lines, expires: now + 30_000 };
    return lines;
  }

  private async getEmpUserMappings(): Promise<{ empToUser: Map<number, string>; userToEmp: Map<string, number> }> {
    const now = Date.now();
    if (this.empUserCache && this.empUserCache.expires > now) {
      return this.empUserCache;
    }

    const empToUser = new Map<number, string>();
    const userToEmp = new Map<string, number>();

    if (!this.prisma?.employee_profiles?.findMany) {
      return { empToUser, userToEmp };
    }

    const profiles = await readUntilMigrated(
      () =>
        this.prisma.employee_profiles.findMany({
          where: {
            employment_status: EmployeeStatus.ACTIVE,
            user_id: { not: null },
          },
          select: { id: true, user_id: true },
        }),
      [] as { id: number; user_id: string | null }[],
    );

    for (const p of profiles) {
      if (p.user_id) {
        empToUser.set(p.id, p.user_id);
        userToEmp.set(p.user_id, p.id);
      }
    }

    this.empUserCache = { empToUser, userToEmp, expires: now + 30_000 };
    return this.empUserCache;
  }
}
