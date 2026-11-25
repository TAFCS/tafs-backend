import { Body, Controller, Get, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { Action } from '../../auth/casl/actions';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../../utils/serializer.util';
import { BulkMarkInstallmentsCollectedDto, ListSecurityDepositsQueryDto } from './dto/security-deposits.dto';
import { SecurityDepositsService } from './security-deposits.service';

@ApiTags('HR Employee Security Deposits')
@ApiBearerAuth()
@Controller('hr/security-deposits')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class SecurityDepositsListController {
  constructor(private readonly securityDeposits: SecurityDepositsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.security_deposits#view')
  async list(
    @Query() query: ListSecurityDepositsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.securityDeposits.listOpen(user, query.status);
    return createApiResponse(data, HttpStatus.OK, 'Security deposits retrieved successfully');
  }

  /** TAFSD-589: mark one cycle's installment collected outside payroll for several employees. */
  @Post('mark-collected')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.security_deposits#mark_collected')
  async markCollectedBulk(
    @Body() dto: BulkMarkInstallmentsCollectedDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.securityDeposits.markCollectedBulk(dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Installments marked collected');
  }
}
