import { Controller, Get, UseGuards, HttpStatus, Query } from '@nestjs/common';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { AnalyticsService } from './analytics.service';
import { createApiResponse } from '../../utils/serializer.util';

@Controller('analytics')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('dashboard')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'all'))
  async getDashboardData(@Query('campusId') campusId?: string) {
    const cid = campusId ? parseInt(campusId, 10) : undefined;
    const stats = await this.analyticsService.getDashboardStats(cid);
    return createApiResponse(stats, HttpStatus.OK, 'Dashboard analytics retrieved successfully');
  }
}
