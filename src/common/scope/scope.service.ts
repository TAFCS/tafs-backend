import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ScopeDimension, StaffRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { IJwtStaffPayload } from '../../modules/auth/interfaces/jwt-payload.interface';
import { readUntilMigrated } from '../../utils/pending-migration.util';
import {
  EMPTY_SCOPE,
  SCOPE_DIMENSION_LABEL,
  SCOPE_FIELD_BY_DIMENSION,
  scopeAllows,
  scopeFromEntries,
  whereForEmployees,
  whereForStudents,
  type UserScope,
} from './scope.types';

/**
 * The single place scope is resolved and enforced.
 *
 * Before this existed, `private assertCampusAccess(user, campusId)` was
 * copy-pasted into 12 services, each re-implementing the same single-campus
 * check, and segments/sections were never enforced anywhere. Inject this
 * instead of writing another copy.
 */
@Injectable()
export class ScopeService {
  private readonly logger = new Logger(ScopeService.name);
  private warnedPendingMigration = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads a user's scope from the database. Called on every login and token
   * refresh, so it must not throw when user_scope_entries has not been
   * migrated onto the shared DB yet (CLAUDE.md rule 11) -- an unmigrated
   * deploy would otherwise break every login for a feature nobody is using.
   * Falling back to EMPTY_SCOPE means unrestricted, which is the behaviour
   * those sessions already had.
   */
  async resolve(userId: string): Promise<UserScope> {
    const entries = await readUntilMigrated(
      () =>
        this.prisma.user_scope_entries.findMany({
          where: { user_id: userId },
          select: { dimension: true, ref_id: true },
        }),
      [] as { dimension: ScopeDimension; ref_id: number }[],
      () => {
        if (this.warnedPendingMigration) return;
        this.warnedPendingMigration = true;
        this.logger.warn(
          'user_scope_entries is not migrated yet - every user resolves as unrestricted. ' +
            'Run `prisma migrate deploy` to activate scope enforcement.',
        );
      },
    );
    return scopeFromEntries(entries);
  }

  async setScope(userId: string, scope: Partial<UserScope>): Promise<UserScope> {
    const rows: { user_id: string; dimension: ScopeDimension; ref_id: number }[] = [];
    for (const [dimension, field] of Object.entries(SCOPE_FIELD_BY_DIMENSION) as [
      ScopeDimension,
      keyof UserScope,
    ][]) {
      for (const ref_id of new Set(scope[field] ?? [])) {
        rows.push({ user_id: userId, dimension, ref_id });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user_scope_entries.deleteMany({ where: { user_id: userId } });
      if (rows.length > 0) {
        await tx.user_scope_entries.createMany({ data: rows, skipDuplicates: true });
      }
    });

    return this.resolve(userId);
  }

  /**
   * The scope carried on the session. Absent on tokens issued before scope
   * shipped, which resolves to unrestricted — the behaviour those sessions
   * already had.
   */
  scopeOf(user: Pick<IJwtStaffPayload, 'role'> & { scope?: UserScope }): UserScope {
    if (user.role === StaffRole.SUPER_ADMIN) return EMPTY_SCOPE;
    return user.scope ?? EMPTY_SCOPE;
  }

  /** SUPER_ADMIN is never scoped. */
  isExempt(user: Pick<IJwtStaffPayload, 'role'>): boolean {
    return user.role === StaffRole.SUPER_ADMIN;
  }

  // ─── Assertions ────────────────────────────────────────────────────────────

  private assertDimension(
    user: Pick<IJwtStaffPayload, 'role'> & { scope?: UserScope },
    dimension: ScopeDimension,
    id: number | null | undefined,
  ) {
    if (this.isExempt(user)) return;
    const field = SCOPE_FIELD_BY_DIMENSION[dimension];
    if (scopeAllows(this.scopeOf(user), field, id)) return;
    throw new ForbiddenException(
      `Outside your assigned ${SCOPE_DIMENSION_LABEL[dimension]} scope.`,
    );
  }

  assertCampus(user: Parameters<ScopeService['assertDimension']>[0], id: number | null | undefined) {
    this.assertDimension(user, ScopeDimension.CAMPUS, id);
  }

  assertSegment(user: Parameters<ScopeService['assertDimension']>[0], id: number | null | undefined) {
    this.assertDimension(user, ScopeDimension.SEGMENT, id);
  }

  assertClass(user: Parameters<ScopeService['assertDimension']>[0], id: number | null | undefined) {
    this.assertDimension(user, ScopeDimension.CLASS, id);
  }

  assertSection(user: Parameters<ScopeService['assertDimension']>[0], id: number | null | undefined) {
    this.assertDimension(user, ScopeDimension.SECTION, id);
  }

  assertDepartment(user: Parameters<ScopeService['assertDimension']>[0], id: number | null | undefined) {
    this.assertDimension(user, ScopeDimension.DEPARTMENT, id);
  }

  assertStaffCategory(user: Parameters<ScopeService['assertDimension']>[0], id: number | null | undefined) {
    this.assertDimension(user, ScopeDimension.STAFF_CATEGORY, id);
  }

  /**
   * Asserts every dimension an employee record carries. Use on any `:id` route
   * in the employee directory before acting on the record.
   */
  assertEmployee(
    user: Parameters<ScopeService['assertDimension']>[0],
    employee: {
      campus_id?: number | null;
      segment_id?: number | null;
      department_id?: number | null;
      staff_category_id?: number | null;
    },
  ) {
    if (this.isExempt(user)) return;
    this.assertCampus(user, employee.campus_id);
    this.assertSegment(user, employee.segment_id);
    this.assertDepartment(user, employee.department_id);
    this.assertStaffCategory(user, employee.staff_category_id);
  }

  /** Non-throwing counterpart, for turning a 403 into a 404 on lookups. */
  canSeeEmployee(
    user: Parameters<ScopeService['assertDimension']>[0],
    employee: {
      campus_id?: number | null;
      segment_id?: number | null;
      department_id?: number | null;
      staff_category_id?: number | null;
    },
  ): boolean {
    try {
      this.assertEmployee(user, employee);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Query fragments ───────────────────────────────────────────────────────

  whereForEmployees(user: Parameters<ScopeService['assertDimension']>[0]) {
    if (this.isExempt(user)) return {};
    return whereForEmployees(this.scopeOf(user));
  }

  whereForStudents(user: Parameters<ScopeService['assertDimension']>[0]) {
    if (this.isExempt(user)) return {};
    return whereForStudents(this.scopeOf(user));
  }
}
