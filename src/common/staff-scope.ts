import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IJwtStaffPayload } from '../modules/auth/interfaces/jwt-payload.interface';
import { effectiveScopeOf } from './scope/scope.types';

// Thin adapters over the universal scope for call sites that predate
// ScopeService. They read effectiveScopeOf — never `user.campusId`, which is
// the person's home campus (payroll / staff app), not what they may access.
// New code should inject ScopeService instead.

function asIds(value: number | number[] | null | undefined): number[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** A requested id / id list as a filter, so scoping never widens past it. */
function asFilter(value: number | number[] | null | undefined): number | { in: number[] } | undefined {
  const ids = asIds(value);
  if (ids.length === 0) return undefined;
  return ids.length === 1 ? ids[0] : { in: ids };
}

/** Narrows an existing `{ in: [...] }` / number filter to `allowed`, or sets it. */
function narrow(
  existing: unknown,
  allowed: number[],
  label: string,
): number | { in: number[] } {
  if (typeof existing === 'number') {
    if (!allowed.includes(existing)) {
      throw new ForbiddenException(`You do not have access to this ${label}`);
    }
    return existing;
  }
  if (
    existing &&
    typeof existing === 'object' &&
    'in' in existing &&
    Array.isArray((existing as { in: number[] }).in)
  ) {
    return { in: (existing as { in: number[] }).in.filter((id) => allowed.includes(id)) };
  }
  return { in: allowed };
}

/**
 * Applies the caller's campus and class scope to a student query. Explicitly
 * requested campus/class ids outside scope are refused.
 */
export function applyStudentScope(
  user: IJwtStaffPayload,
  where: Prisma.studentsWhereInput,
  query?: { campus_id?: number | number[]; class_id?: number | number[] },
): Prisma.studentsWhereInput {
  const scope = effectiveScopeOf(user);
  const scoped = { ...where };

  if (scope.campuses.length > 0) {
    if (asIds(query?.campus_id).some((id) => !scope.campuses.includes(id))) {
      throw new ForbiddenException('You do not have access to this campus');
    }
    scoped.campus_id = narrow(scoped.campus_id ?? asFilter(query?.campus_id), scope.campuses, 'campus');
  }

  if (scope.classes.length > 0) {
    if (asIds(query?.class_id).some((id) => !scope.classes.includes(id))) {
      throw new ForbiddenException('You do not have access to this class');
    }
    scoped.class_id = narrow(scoped.class_id ?? asFilter(query?.class_id), scope.classes, 'class');
  }

  return scoped;
}

export function assertCampusInScope(user: IJwtStaffPayload, campusId: number): void {
  const { campuses } = effectiveScopeOf(user);
  if (campuses.length > 0 && !campuses.includes(campusId)) {
    throw new ForbiddenException('You do not have access to this campus');
  }
}

export function assertClassInScope(
  user: IJwtStaffPayload,
  classId: number | null | undefined,
): void {
  const { classes } = effectiveScopeOf(user);
  if (classes.length > 0 && classId != null && !classes.includes(classId)) {
    throw new ForbiddenException('You do not have access to this class');
  }
}

/** Resolve one or more campus IDs for analytics filters (CSV / multi-select). */
export function resolveAnalyticsCampusIds(
  user: IJwtStaffPayload,
  requestedCampusIds?: number[],
): number[] | undefined {
  const { campuses } = effectiveScopeOf(user);
  if (requestedCampusIds?.length) {
    if (campuses.length > 0 && requestedCampusIds.some((id) => !campuses.includes(id))) {
      throw new ForbiddenException('You do not have access to this campus');
    }
    return requestedCampusIds;
  }
  return campuses.length > 0 ? [...campuses] : undefined;
}
