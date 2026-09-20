import { Controller, Get, Post, Patch, Delete, Body, Query, Param, ParseIntPipe, UseGuards, HttpStatus } from '@nestjs/common';
import { PoliciesService, CreatePolicySetDto, CreatePolicyRuleDto } from './policies.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';

// Attendance Settings (attendance policy sets and their rules). Called only by
// the attendance-settings page and the older hr/policies page, which is the same
// feature under the same capability.
@ApiTags('HR Policies')
@ApiBearerAuth()
@Controller('hr/policies')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class PoliciesController {
  constructor(private readonly policiesService: PoliciesService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Policy'))
  @RequireAction('attendance.settings#view')
  async findAll(@Query('campusId') campusId: string, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.policiesService.findAllSets(parseInt(campusId, 10), user);
    return createApiResponse(data, HttpStatus.OK, 'Policy sets retrieved successfully');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Policy'))
  @RequireAction('attendance.settings#view')
  async findOneSet(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.policiesService.findOneSet(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Policy set retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  @RequireAction('attendance.settings#sets.manage')
  async createSet(@Body() dto: CreatePolicySetDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.policiesService.createSet(dto, user.username, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Policy set created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  @RequireAction('attendance.settings#sets.manage')
  async updateSet(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreatePolicySetDto>,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.policiesService.updateSet(id, dto, user.username, user);
    return createApiResponse(data, HttpStatus.OK, 'Policy set updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  @RequireAction('attendance.settings#sets.manage')
  async removeSet(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.policiesService.removeSet(id, user.username, user);
    return createApiResponse(data, HttpStatus.OK, 'Policy set deleted successfully');
  }

  // Rules
  @Post(':id/rules')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  @RequireAction('attendance.settings#rules.manage')
  async createRule(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreatePolicyRuleDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.policiesService.createRule(id, dto, user.username, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Policy rule created successfully');
  }

  @Patch(':id/rules/:ruleId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  @RequireAction('attendance.settings#rules.manage')
  async updateRule(
    @Param('id', ParseIntPipe) id: number,
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Body() dto: Partial<CreatePolicyRuleDto>,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.policiesService.updateRule(id, ruleId, dto, user.username, user);
    return createApiResponse(data, HttpStatus.OK, 'Policy rule updated successfully');
  }

  @Delete(':id/rules/:ruleId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  @RequireAction('attendance.settings#rules.manage')
  async removeRule(
    @Param('id', ParseIntPipe) id: number,
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.policiesService.removeRule(id, ruleId, user.username, user);
    return createApiResponse(data, HttpStatus.OK, 'Policy rule deleted successfully');
  }
}
