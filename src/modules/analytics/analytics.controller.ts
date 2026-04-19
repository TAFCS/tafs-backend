import { Controller, Get, UseGuards, HttpStatus } from '@nestjs/common';
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
  @CheckPolicies((ability) => ability.can(Action.Manage, 'all')) // Restrict to Super Admins (who have manage 'all')
  async getDashboardData() {
    const stats = await this.analyticsService.getDashboardStats();
    return createApiResponse(stats, HttpStatus.OK, 'Dashboard analytics retrieved successfully');
  }
}
