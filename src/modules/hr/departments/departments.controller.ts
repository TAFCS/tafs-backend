import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards, HttpStatus } from '@nestjs/common';
import {
  DepartmentsService,
  CreateDepartmentDto,
  CreateStaffCategoryDto,
} from './departments.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';

@ApiTags('HR Departments')
@ApiBearerAuth()
@Controller('hr/departments')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async findAll() {
    const data = await this.departmentsService.findAll();
    return createApiResponse(data, HttpStatus.OK, 'Departments retrieved successfully');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const data = await this.departmentsService.findOne(id);
    return createApiResponse(data, HttpStatus.OK, 'Department retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.departments#create')
  async create(@Body() dto: CreateDepartmentDto) {
    const data = await this.departmentsService.create(dto);
    return createApiResponse(data, HttpStatus.CREATED, 'Department created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.departments#edit')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateDepartmentDto>) {
    const data = await this.departmentsService.update(id, dto);
    return createApiResponse(data, HttpStatus.OK, 'Department updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.departments#delete')
  async remove(@Param('id', ParseIntPipe) id: number) {
    const data = await this.departmentsService.remove(id);
    return createApiResponse(data, HttpStatus.OK, 'Department deleted successfully');
  }

  // Staff categories (subcategories)
  @Post(':id/staff-categories')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.departments#create')
  async createStaffCategory(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateStaffCategoryDto) {
    const data = await this.departmentsService.createStaffCategory(id, dto);
    return createApiResponse(data, HttpStatus.CREATED, 'Staff category created successfully');
  }

  @Patch(':id/staff-categories/:categoryId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.departments#edit')
  async updateStaffCategory(
    @Param('id', ParseIntPipe) id: number,
    @Param('categoryId', ParseIntPipe) categoryId: number,
    @Body() dto: Partial<CreateStaffCategoryDto>
  ) {
    const data = await this.departmentsService.updateStaffCategory(id, categoryId, dto);
    return createApiResponse(data, HttpStatus.OK, 'Staff category updated successfully');
  }

  @Delete(':id/staff-categories/:categoryId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.departments#delete')
  async removeStaffCategory(
    @Param('id', ParseIntPipe) id: number,
    @Param('categoryId', ParseIntPipe) categoryId: number
  ) {
    const data = await this.departmentsService.removeStaffCategory(id, categoryId);
    return createApiResponse(data, HttpStatus.OK, 'Staff category deleted successfully');
  }
}
