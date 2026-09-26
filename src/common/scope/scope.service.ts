import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ScopeDimension, StaffRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { IJwtStaffPayload } from '../../modules/auth/interfaces/jwt-payload.interface';
import { readUntilMigrated } from '../../utils/pending-migration.util';
import {
  effectiveScopeOf,
  isFullyUnrestricted,
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

  /** The scope the session is held to — see effectiveScopeOf. */
  scopeOf(user: Pick<IJwtStaffPayload, 'role'> & Partial<Pick<IJwtStaffPayload, 'campusId' | 'allowedClassIds'>> & { scope?: UserScope }): UserScope {
    return effectiveScopeOf(user);
  }

  /**
   * Campus ids a list/aggregate query should cover. An explicit request is
   * asserted id by id and returned as-is; otherwise the caller's campus scope,
   * or `undefined` for "every campus" when campus is unrestricted.
   */
  campusIdsFor(
    user: Parameters<ScopeService['assertDimension']>[0],
    requested?: number | number[] | null,
  ): number[] | undefined {
    const ids = requested == null ? [] : Array.isArray(requested) ? requested : [requested];
    if (ids.length > 0) {
      for (const id of ids) this.assertCampus(user, id);
      return ids;
    }
    const campuses = this.scopeOf(user).campuses;
    return campuses.length > 0 ? [...campuses] : undefined;
  }

  /** The campus to assume when a request names none: the caller's only scoped
   * campus, else undefined (the caller must pick). Never the home campus. */
  defaultCampusId(user: Parameters<ScopeService['assertDimension']>[0]): number | undefined {
    const campuses = this.scopeOf(user).campuses;
    return campuses.length === 1 ? campuses[0] : undefined;
  }

  /** Class ids the caller is restricted to, or `undefined` when unrestricted. */
  classIdsFor(user: Parameters<ScopeService['assertDimension']>[0]): number[] | undefined {
    const classes = this.scopeOf(user).classes;
    return classes.length > 0 ? [...classes] : undefined;
  }

  /** SUPER_ADMIN is never scoped. */
  isExempt(user: Pick<IJwtStaffPayload, 'role'>): boolean {
    return user.role === StaffRole.SUPER_ADMIN;
  }

  // ─── Assertions ────────────────────────────────────────────────────────────

  private assertDimension(
    user: Pick<IJwtStaffPayload, 'role'> & Partial<Pick<IJwtStaffPayload, 'campusId' | 'allowedClassIds'>> & { scope?: UserScope },
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

  /**
   * Asserts every dimension a student record carries. Use on any `:id` /
   * `:cc` route that acts on one student.
   *
   * SEGMENT rides on the student's class, so pass `segment_id` from
   * `classes.segment_id` when the caller has it -- omitting it on a
   * segment-scoped user would let the record through.
   */
  assertStudent(
    user: Parameters<ScopeService['assertDimension']>[0],
    student: {
      campus_id?: number | null;
      class_id?: number | null;
      section_id?: number | null;
      segment_id?: number | null;
    },
  ) {
    if (this.isExempt(user)) return;
    this.assertCampus(user, student.campus_id);
    this.assertClass(user, student.class_id);
    this.assertSection(user, student.section_id);
    this.assertSegment(user, student.segment_id);
  }

  /**
   * True when nothing narrows the caller: SUPER_ADMIN, or no universal scope on
   * any dimension and no legacy campus / class field on an older token. For
   * routes that reach every campus at once and cannot be cut down per row.
   */
  isUnrestricted(user: Parameters<ScopeService['assertDimension']>[0]): boolean {
    if (this.isExempt(user)) return true;
    return isFullyUnrestricted(this.scopeOf(user));
  }

  /** Non-throwing counterpart, for turning a 403 into a 404 on lookups. */
  canSeeStudent(
    user: Parameters<ScopeService['assertDimension']>[0],
    student: {
      campus_id?: number | null;
      class_id?: number | null;
      section_id?: number | null;
      segment_id?: number | null;
    },
  ): boolean {
    try {
      this.assertStudent(user, student);
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
