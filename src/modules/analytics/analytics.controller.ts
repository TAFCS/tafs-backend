import { Controller, Get, UseGuards, HttpStatus, Query } from '@nestjs/common';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { AnalyticsService } from './analytics.service';
import { createApiResponse } from '../../utils/serializer.util';
import { toNumberArray } from '../../common/transforms/query-array.transform';
import { ScopeService } from '../../common/scope/scope.service';

@Controller('analytics')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly scope: ScopeService,
  ) {}

  // Campus ids come from an explicit request (each asserted in scope) or the
  // caller's campus scope; class ids from their class scope. Empty means "no
  // restriction" to analytics.service.ts, which is exactly what an
  // unrestricted dimension is.
  private resolveEffectiveFilters(
    user: IJwtStaffPayload,
    requested: number[] | undefined,
  ): { campusIds: number[] | undefined; classIds: number[] } {
    return {
      campusIds: this.scope.campusIdsFor(user, requested),
      classIds: this.scope.classIdsFor(user) ?? [],
    };
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
    const { campusIds, classIds } = this.resolveEffectiveFilters(user, requested);
    const stats = await this.analyticsService.getDashboardStats(campusIds, classIds);
    return createApiResponse(stats, HttpStatus.OK, 'Dashboard analytics retrieved successfully');
  }

  @Get('module-stats')
  async getModuleStats(
    @Query('campusId') campusId: string | undefined,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const requested = toNumberArray({ value: campusId });
    const { campusIds, classIds } = this.resolveEffectiveFilters(user, requested);
    const stats = await this.analyticsService.getModuleStats(campusIds, classIds);
    return createApiResponse(stats, HttpStatus.OK, 'Module stats retrieved successfully');
  }
}
