import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { Action } from '../../auth/casl/actions';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../../utils/serializer.util';
import { ListSecurityDepositsQueryDto } from './dto/security-deposits.dto';
import { SecurityDepositsService } from './security-deposits.service';

@ApiTags('HR Employee Security Deposits')
@ApiBearerAuth()
@Controller('hr/security-deposits')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class SecurityDepositsListController {
  constructor(private readonly securityDeposits: SecurityDepositsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async list(
    @Query() query: ListSecurityDepositsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.securityDeposits.listOpen(user, query.status);
    return createApiResponse(data, HttpStatus.OK, 'Security deposits retrieved successfully');
  }
}
