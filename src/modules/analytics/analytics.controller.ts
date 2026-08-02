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

@Controller('analytics')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

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
    const campusIds = resolveAnalyticsCampusIds(user, requested);
    const stats = await this.analyticsService.getDashboardStats(
      campusIds,
      user.allowedClassIds,
    );
    return createApiResponse(stats, HttpStatus.OK, 'Dashboard analytics retrieved successfully');
  }

  @Get('module-stats')
  async getModuleStats(
    @Query('campusId') campusId: string | undefined,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const requested = toNumberArray({ value: campusId });
    const campusIds = resolveAnalyticsCampusIds(user, requested);
    const stats = await this.analyticsService.getModuleStats(
      campusIds,
      user.allowedClassIds,
    );
    return createApiResponse(stats, HttpStatus.OK, 'Module stats retrieved successfully');
  }
}
