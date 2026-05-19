import { Controller, Get, Post, Patch, Delete, Body, Query, Param, ParseIntPipe, UseGuards, HttpStatus } from '@nestjs/common';
import { PoliciesService, CreatePolicySetDto, CreatePolicyRuleDto } from './policies.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';

@ApiTags('HR Policies')
@ApiBearerAuth()
@Controller('hr/policies')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class PoliciesController {
  constructor(private readonly policiesService: PoliciesService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Policy'))
  async findAll(@Query('campusId') campusId: string) {
    const data = await this.policiesService.findAllSets(parseInt(campusId, 10));
    return createApiResponse(data, HttpStatus.OK, 'Policy sets retrieved successfully');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Policy'))
  async findOneSet(@Param('id', ParseIntPipe) id: number) {
    const data = await this.policiesService.findOneSet(id);
    return createApiResponse(data, HttpStatus.OK, 'Policy set retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  async createSet(@Body() dto: CreatePolicySetDto) {
    const data = await this.policiesService.createSet(dto);
    return createApiResponse(data, HttpStatus.CREATED, 'Policy set created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  async updateSet(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreatePolicySetDto>) {
    const data = await this.policiesService.updateSet(id, dto);
    return createApiResponse(data, HttpStatus.OK, 'Policy set updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  async removeSet(@Param('id', ParseIntPipe) id: number) {
    const data = await this.policiesService.removeSet(id);
    return createApiResponse(data, HttpStatus.OK, 'Policy set deleted successfully');
  }

  // Rules
  @Post(':id/rules')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  async createRule(@Param('id', ParseIntPipe) id: number, @Body() dto: CreatePolicyRuleDto) {
    const data = await this.policiesService.createRule(id, dto);
    return createApiResponse(data, HttpStatus.CREATED, 'Policy rule created successfully');
  }

  @Patch(':id/rules/:ruleId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  async updateRule(
    @Param('id', ParseIntPipe) id: number,
    @Param('ruleId', ParseIntPipe) ruleId: number,
    @Body() dto: Partial<CreatePolicyRuleDto>
  ) {
    const data = await this.policiesService.updateRule(id, ruleId, dto);
    return createApiResponse(data, HttpStatus.OK, 'Policy rule updated successfully');
  }

  @Delete(':id/rules/:ruleId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Policy'))
  async removeRule(
    @Param('id', ParseIntPipe) id: number,
    @Param('ruleId', ParseIntPipe) ruleId: number
  ) {
    const data = await this.policiesService.removeRule(id, ruleId);
    return createApiResponse(data, HttpStatus.OK, 'Policy rule deleted successfully');
  }
}
