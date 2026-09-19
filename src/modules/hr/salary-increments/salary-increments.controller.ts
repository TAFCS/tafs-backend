import { Body, Controller, Get, HttpStatus, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { RequireAction, RequireAnyAction } from '../../../decorators/require-action.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import { Action } from '../../auth/casl/actions';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { DueSalaryIncrementsQueryDto, SalaryIncrementApplyDto, UpdateSalaryIncrementSettingsDto } from './dto/salary-increments.dto';
import { SalaryIncrementsService } from './salary-increments.service';
// `settings` (read) and `apply` are ALSO reachable from
// EmployeeSalaryIncrementSection.tsx inside the Employee Directory (gated
// there on hr.employee_directory#schedule_pay.edit) — @RequireAnyAction on
// those two; `due`/`analytics`/`preview`/settings-edit are standalone-only.
@ApiTags('Salary Increments') @ApiBearerAuth() @Controller('hr/salary-increments') @UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class SalaryIncrementsController { constructor(private readonly service: SalaryIncrementsService) {}
 @Get('settings') @CheckPolicies(a => a.can(Action.Read, 'Employee')) @RequireAnyAction('hr.salary_increments#view', 'hr.employee_directory#schedule_pay.view') async settings() { return createApiResponse(await this.service.getSettings(), HttpStatus.OK, 'Salary increment settings retrieved'); }
 @Patch('settings') @CheckPolicies(a => a.can(Action.Manage, 'Employee')) @RequireAction('hr.salary_increments#settings.edit') async updateSettings(@Body() dto: UpdateSalaryIncrementSettingsDto, @CurrentUser() user: IJwtStaffPayload) { return createApiResponse(await this.service.updateSettings(dto, user), HttpStatus.OK, 'Salary increment settings updated'); }
 @Get('due') @CheckPolicies(a => a.can(Action.Read, 'Employee')) @RequireAction('hr.salary_increments#view') async due(@Query() query: DueSalaryIncrementsQueryDto, @CurrentUser() user: IJwtStaffPayload) { return createApiResponse(await this.service.due(query, user), HttpStatus.OK, 'Salary increment queue retrieved'); }
 @Get('analytics') @CheckPolicies(a => a.can(Action.Read, 'Employee')) @RequireAction('hr.salary_increments#view') async analytics(@CurrentUser() user: IJwtStaffPayload) { return createApiResponse(await this.service.analytics(user), HttpStatus.OK, 'Salary increment analytics retrieved'); }
 @Post('preview') @CheckPolicies(a => a.can(Action.Manage, 'Employee')) @RequireAction('hr.salary_increments#view') async preview(@Body() dto: SalaryIncrementApplyDto, @CurrentUser() user: IJwtStaffPayload) { return createApiResponse(await this.service.preview(dto, user), HttpStatus.OK, 'Salary increment preview ready'); }
 @Post('apply') @CheckPolicies(a => a.can(Action.Manage, 'Employee')) @RequireAnyAction('hr.salary_increments#apply', 'hr.employee_directory#schedule_pay.edit') async apply(@Body() dto: SalaryIncrementApplyDto, @CurrentUser() user: IJwtStaffPayload) { return createApiResponse(await this.service.apply(dto, user), HttpStatus.OK, 'Salary increments applied'); }
}
