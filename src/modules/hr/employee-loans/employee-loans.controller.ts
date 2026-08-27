import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { Action } from '../../auth/casl/actions';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../../utils/serializer.util';
import { EmployeeLoansService } from './employee-loans.service';
import { CreateLoanDto, LumpSumRepaymentDto, UpdateInstallmentScheduleDto, WriteOffLoanDto } from './dto/employee-loans.dto';

@ApiTags('HR Employee Loans')
@ApiBearerAuth()
@Controller('hr/employees/:employeeId/loan')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class EmployeeLoansController {
  constructor(private readonly employeeLoans: EmployeeLoansService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async getOne(@Param('employeeId', ParseIntPipe) employeeId: number) {
    const data = await this.employeeLoans.getForEmployee(employeeId);
    return createApiResponse(data, HttpStatus.OK, 'Loan retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async create(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: CreateLoanDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeeLoans.create(employeeId, dto, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Loan created successfully');
  }

  @Post('schedule')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async updateSchedule(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: UpdateInstallmentScheduleDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeeLoans.updateSchedule(employeeId, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Loan recovery plan updated');
  }

  @Post('lump-sum')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async lumpSum(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: LumpSumRepaymentDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeeLoans.repayLumpSum(employeeId, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Lump-sum repayment recorded');
  }

  @Post('write-off')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async writeOff(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: WriteOffLoanDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeeLoans.writeOff(employeeId, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Loan write-off recorded');
  }

  @Post('cancel')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async cancel(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeeLoans.cancel(employeeId, user);
    return createApiResponse(data, HttpStatus.OK, 'Loan cancelled');
  }

  @Post('mark-outstanding')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async markOutstanding(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeeLoans.markOutstanding(employeeId, user);
    return createApiResponse(data, HttpStatus.OK, 'Loan marked outstanding');
  }
}
