import { Controller, Get, Post, Patch, Delete, Body, Query, Param, ParseIntPipe, UseGuards, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PayrollRulesService } from './payroll-rules.service';
import { CreatePayrollStatutoryRuleDto } from './dto/payroll-rules.dto';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { createApiResponse } from '../../../utils/serializer.util';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';

@ApiTags('HR Payroll Statutory Rules')
@ApiBearerAuth()
@Controller('hr/payroll/statutory-rules')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class PayrollRulesController {
  constructor(private readonly payrollRulesService: PayrollRulesService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Payroll'))
  async findAll(@Query('ruleType') ruleType?: string) {
    const data = await this.payrollRulesService.findAll(ruleType);
    return createApiResponse(data, HttpStatus.OK, 'Payroll statutory rules retrieved successfully');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Payroll'))
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const data = await this.payrollRulesService.findOne(id);
    return createApiResponse(data, HttpStatus.OK, 'Payroll statutory rule retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Payroll'))
  async create(@Body() dto: CreatePayrollStatutoryRuleDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.payrollRulesService.create(dto, user.username);
    return createApiResponse(data, HttpStatus.CREATED, 'Payroll statutory rule created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Payroll'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreatePayrollStatutoryRuleDto>,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.payrollRulesService.update(id, dto, user.username);
    return createApiResponse(data, HttpStatus.OK, 'Payroll statutory rule updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Payroll'))
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.payrollRulesService.remove(id, user.username);
    return createApiResponse(data, HttpStatus.OK, 'Payroll statutory rule deleted successfully');
  }
}
