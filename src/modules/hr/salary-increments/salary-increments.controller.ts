import { Body, Controller, Get, HttpStatus, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import { Action } from '../../auth/casl/actions';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { DueSalaryIncrementsQueryDto, SalaryIncrementApplyDto, UpdateSalaryIncrementSettingsDto } from './dto/salary-increments.dto';
import { SalaryIncrementsService } from './salary-increments.service';
@ApiTags('Salary Increments') @ApiBearerAuth() @Controller('hr/salary-increments') @UseGuards(JwtStaffGuard, PoliciesGuard)
export class SalaryIncrementsController { constructor(private readonly service: SalaryIncrementsService) {}
 @Get('settings') @CheckPolicies(a => a.can(Action.Read, 'Employee')) async settings() { return createApiResponse(await this.service.getSettings(), HttpStatus.OK, 'Salary increment settings retrieved'); }
 @Patch('settings') @CheckPolicies(a => a.can(Action.Manage, 'Employee')) async updateSettings(@Body() dto: UpdateSalaryIncrementSettingsDto, @CurrentUser() user: IJwtStaffPayload) { return createApiResponse(await this.service.updateSettings(dto, user), HttpStatus.OK, 'Salary increment settings updated'); }
 @Get('due') @CheckPolicies(a => a.can(Action.Read, 'Employee')) async due(@Query() query: DueSalaryIncrementsQueryDto, @CurrentUser() user: IJwtStaffPayload) { return createApiResponse(await this.service.due(query, user), HttpStatus.OK, 'Salary increment queue retrieved'); }
 @Get('analytics') @CheckPolicies(a => a.can(Action.Read, 'Employee')) async analytics(@CurrentUser() user: IJwtStaffPayload) { return createApiResponse(await this.service.analytics(user), HttpStatus.OK, 'Salary increment analytics retrieved'); }
 @Post('preview') @CheckPolicies(a => a.can(Action.Manage, 'Employee')) async preview(@Body() dto: SalaryIncrementApplyDto, @CurrentUser() user: IJwtStaffPayload) { return createApiResponse(await this.service.preview(dto, user), HttpStatus.OK, 'Salary increment preview ready'); }
 @Post('apply') @CheckPolicies(a => a.can(Action.Manage, 'Employee')) async apply(@Body() dto: SalaryIncrementApplyDto, @CurrentUser() user: IJwtStaffPayload) { return createApiResponse(await this.service.apply(dto, user), HttpStatus.OK, 'Salary increments applied'); }
}
