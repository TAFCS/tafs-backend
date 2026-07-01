import { Controller, Get, UseGuards, HttpStatus, Query } from '@nestjs/common';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { AnalyticsService } from './analytics.service';
import { createApiResponse } from '../../utils/serializer.util';
import { resolveAnalyticsCampusId } from '../../common/staff-scope';

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
    const requested = campusId ? parseInt(campusId, 10) : undefined;
    const cid = resolveAnalyticsCampusId(user, requested);
    const stats = await this.analyticsService.getDashboardStats(
      cid,
      user.allowedClassIds,
    );
    return createApiResponse(stats, HttpStatus.OK, 'Dashboard analytics retrieved successfully');
  }

  @Get('module-stats')
  async getModuleStats(
    @Query('campusId') campusId: string | undefined,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const requested = campusId ? parseInt(campusId, 10) : undefined;
    const cid = resolveAnalyticsCampusId(user, requested);
    const stats = await this.analyticsService.getModuleStats(
      cid,
      user.allowedClassIds,
    );
    return createApiResponse(stats, HttpStatus.OK, 'Module stats retrieved successfully');
  }
}

