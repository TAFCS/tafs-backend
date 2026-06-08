import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards, HttpStatus } from '@nestjs/common';
import { StaffTypesService, CreateStaffTypeDto, UpdateStaffTypeDto } from './staff-types.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';

@ApiTags('HR Staff Types')
@ApiBearerAuth()
@Controller('hr/staff-types')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class StaffTypesController {
  constructor(private readonly staffTypesService: StaffTypesService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async findAll() {
    const data = await this.staffTypesService.findAll();
    return createApiResponse(data, HttpStatus.OK, 'Staff types retrieved successfully');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const data = await this.staffTypesService.findOne(id);
    return createApiResponse(data, HttpStatus.OK, 'Staff type retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async create(@Body() dto: CreateStaffTypeDto) {
    const data = await this.staffTypesService.create(dto);
    return createApiResponse(data, HttpStatus.CREATED, 'Staff type created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateStaffTypeDto) {
    const data = await this.staffTypesService.update(id, dto);
    return createApiResponse(data, HttpStatus.OK, 'Staff type updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async remove(@Param('id', ParseIntPipe) id: number) {
    const data = await this.staffTypesService.remove(id);
    return createApiResponse(data, HttpStatus.OK, 'Staff type deleted successfully');
  }
}
