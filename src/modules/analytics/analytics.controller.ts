import { Controller, Get, UseGuards, HttpStatus, Query } from '@nestjs/common';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { AnalyticsService } from './analytics.service';
import { createApiResponse } from '../../utils/serializer.util';
import { resolveAnalyticsCampusIds } from '../../common/staff-scope';
import { toNumberArray } from '../../common/transforms/query-array.transform';
import { ScopeService } from '../../common/scope/scope.service';

// An id no real row can ever have. analytics.service.ts's own filters are all
// shaped `xIds.length > 0 ? { field: { in: xIds } } : {}` — an empty array is
// indistinguishable from "no restriction" to that check, so a genuine denial
// (legacy and universal scope share nothing) must never be represented as
// `[]`, or the filter is silently dropped instead of applied. This sentinel
// keeps the filter live while matching zero rows.
const UNMATCHABLE_ID = -1;

/** The real intersection if the two axes share anything, else the sentinel. */
function intersectOrDeny(requested: number[], allowed: number[]): number[] {
  const overlap = requested.filter((id) => allowed.includes(id));
  return overlap.length > 0 ? overlap : [UNMATCHABLE_ID];
}

@Controller('analytics')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly scope: ScopeService,
  ) {}

  // Universal scope ANDed alongside the legacy resolveAnalyticsCampusIds /
  // allowedClassIds filters: intersect when both restrict, defer to whichever
  // one actually restricts otherwise. resolveAnalyticsCampusIds returns
  // undefined ("no filter") for a user with no legacy campusId even when they
  // carry a universal multi-campus scope — the gap this closes. See the
  // scope-sweep handoff before removing either legacy source.
  private resolveEffectiveFilters(
    user: IJwtStaffPayload,
    legacyCampusIds: number[] | undefined,
  ): { campusIds: number[] | undefined; classIds: number[] } {
    const universalScope = this.scope.scopeOf(user);
    const campusIds = universalScope.campuses.length > 0
      ? legacyCampusIds?.length
        ? intersectOrDeny(legacyCampusIds, universalScope.campuses)
        : universalScope.campuses
      : legacyCampusIds;

    const legacyClassIds = user.allowedClassIds ?? [];
    const classIds = universalScope.classes.length > 0
      ? legacyClassIds.length > 0
        ? intersectOrDeny(legacyClassIds, universalScope.classes)
        : universalScope.classes
      : legacyClassIds;

    return { campusIds, classIds };
  }

  @Get('dashboard')
  @CheckPolicies(
    (ability) =>
      ability.can(Action.Read, 'all') || ability.can(Action.Manage, 'all'),
  )
  async getDashboardData(
    @Query('campusId') campusId: string | undefined,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const requested = toNumberArray({ value: campusId });
    const legacyCampusIds = resolveAnalyticsCampusIds(user, requested);
    const { campusIds, classIds } = this.resolveEffectiveFilters(user, legacyCampusIds);
    const stats = await this.analyticsService.getDashboardStats(campusIds, classIds);
    return createApiResponse(stats, HttpStatus.OK, 'Dashboard analytics retrieved successfully');
  }

  @Get('module-stats')
  async getModuleStats(
    @Query('campusId') campusId: string | undefined,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const requested = toNumberArray({ value: campusId });
    const legacyCampusIds = resolveAnalyticsCampusIds(user, requested);
    const { campusIds, classIds } = this.resolveEffectiveFilters(user, legacyCampusIds);
    const stats = await this.analyticsService.getModuleStats(campusIds, classIds);
    return createApiResponse(stats, HttpStatus.OK, 'Module stats retrieved successfully');
  }
}
