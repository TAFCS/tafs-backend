import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IJwtStaffPayload } from '../modules/auth/interfaces/jwt-payload.interface';

/**
 * Applies campus and class-band scope from the staff JWT to student queries.
 * Empty allowedClassIds with a set campusId = all classes at that campus.
 */
export function applyStudentScope(
  user: IJwtStaffPayload,
  where: Prisma.studentsWhereInput,
  query?: { campus_id?: number | number[]; class_id?: number | number[] },
): Prisma.studentsWhereInput {
  const scoped = { ...where };

  if (user.campusId != null) {
    if (query?.campus_id != null) {
      const requested = Array.isArray(query.campus_id)
        ? query.campus_id
        : [query.campus_id];
      if (requested.some((id) => id !== user.campusId)) {
        throw new ForbiddenException('You do not have access to this campus');
      }
    }
    scoped.campus_id = user.campusId;
  }

  const allowed = user.allowedClassIds ?? [];
  if (allowed.length > 0) {
    if (query?.class_id != null) {
      const requested = Array.isArray(query.class_id)
        ? query.class_id
        : [query.class_id];
      if (requested.some((id) => !allowed.includes(id))) {
        throw new ForbiddenException('You do not have access to this class');
      }
    }
    const existing = scoped.class_id;
    if (
      existing &&
      typeof existing === 'object' &&
      'in' in existing &&
      Array.isArray((existing as { in: number[] }).in)
    ) {
      const intersection = (existing as { in: number[] }).in.filter((id) =>
        allowed.includes(id),
      );
      scoped.class_id = { in: intersection };
    } else if (typeof existing === 'number') {
      if (!allowed.includes(existing)) {
        throw new ForbiddenException('You do not have access to this class');
      }
    } else {
      scoped.class_id = { in: allowed };
    }
  }

  return scoped;
}

export function assertCampusInScope(
  user: IJwtStaffPayload,
  campusId: number,
): void {
  if (user.campusId != null && user.campusId !== campusId) {
    throw new ForbiddenException('You do not have access to this campus');
  }
}

export function assertClassInScope(
  user: IJwtStaffPayload,
  classId: number | null | undefined,
): void {
  const allowed = user.allowedClassIds ?? [];
  if (allowed.length > 0 && classId != null && !allowed.includes(classId)) {
    throw new ForbiddenException('You do not have access to this class');
  }
}

export function resolveAnalyticsCampusId(
  user: IJwtStaffPayload,
  requestedCampusId?: number,
): number | undefined {
  if (user.campusId != null) {
    if (
      requestedCampusId != null &&
      requestedCampusId !== user.campusId
    ) {
      throw new ForbiddenException('You do not have access to this campus');
    }
    return user.campusId;
  }
  return requestedCampusId;
}
