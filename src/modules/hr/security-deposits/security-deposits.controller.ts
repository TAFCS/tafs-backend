import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { Action } from '../../auth/casl/actions';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../../utils/serializer.util';
import { SecurityDepositsService } from './security-deposits.service';
import { CreateSecurityDepositDto, ForfeitSecurityDepositDto, RefundSecurityDepositDto, UpdateInstallmentScheduleDto } from './dto/security-deposits.dto';

@ApiTags('HR Employee Security Deposits')
@ApiBearerAuth()
@Controller('hr/employees/:employeeId/security-deposit')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class SecurityDepositsController {
  constructor(private readonly securityDeposits: SecurityDepositsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async getOne(@Param('employeeId', ParseIntPipe) employeeId: number) {
    const data = await this.securityDeposits.getForEmployee(employeeId);
    return createApiResponse(data, HttpStatus.OK, 'Security deposit retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async create(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: CreateSecurityDepositDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.securityDeposits.create(employeeId, dto, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Security deposit plan created successfully');
  }

  @Post('schedule')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async updateSchedule(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: UpdateInstallmentScheduleDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.securityDeposits.updateSchedule(employeeId, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Security deposit recovery plan updated');
  }

  @Post('refund')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async refund(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: RefundSecurityDepositDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.securityDeposits.refund(employeeId, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Security deposit refund recorded');
  }

  @Post('forfeit')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async forfeit(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: ForfeitSecurityDepositDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.securityDeposits.forfeit(employeeId, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Security deposit forfeiture recorded');
  }

  @Post('cancel')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async cancel(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.securityDeposits.cancel(employeeId, user);
    return createApiResponse(data, HttpStatus.OK, 'Security deposit plan cancelled');
  }
}
