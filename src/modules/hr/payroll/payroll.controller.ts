import { Body, Controller, Delete, Get, HttpStatus, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { Action } from '../../auth/casl/actions';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../../utils/serializer.util';
import { PayrollService } from './payroll.service';
import { GeneratePayrollRunDto, ListPayrollRunsQueryDto } from './dto/payroll.dto';
import { DisbursePayrollLineDto } from './dto/payroll-self.dto';

@ApiTags('HR Payroll')
@ApiBearerAuth()
@Controller('hr/payroll/runs')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class PayrollController {
  constructor(private readonly payrollService: PayrollService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Payroll'))
  async list(@Query() query: ListPayrollRunsQueryDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.payrollService.listRuns(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Payroll runs retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Payroll'))
  async generate(@Body() dto: GeneratePayrollRunDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.payrollService.generateRun(dto, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Payroll run generated successfully');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Payroll'))
  async getOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.payrollService.getRun(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Payroll run retrieved successfully');
  }

  @Post(':id/finalize')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Payroll'))
  async finalize(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.payrollService.finalizeRun(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Payroll run finalized successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Payroll'))
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.payrollService.deleteRun(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Payroll run deleted successfully');
  }

  @Post(':runId/lines/:employeeId/disburse')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Payroll'))
  async disburseLine(
    @Param('runId', ParseIntPipe) runId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: DisbursePayrollLineDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.payrollService.disburseLine(runId, employeeId, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Payroll line marked as disbursed');
  }

  @Post(':runId/disburse-all')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Payroll'))
  async disburseAll(
    @Param('runId', ParseIntPipe) runId: number,
    @Body() dto: DisbursePayrollLineDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.payrollService.disburseAll(runId, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'All undisbursed payroll lines marked as disbursed');
  }
}
