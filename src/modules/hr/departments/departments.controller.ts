import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards, HttpStatus } from '@nestjs/common';
import { DepartmentsService, CreateDepartmentDto, CreateDesignationDto } from './departments.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';

@ApiTags('HR Departments')
@ApiBearerAuth()
@Controller('hr/departments')
@UseGuards(JwtStaffGuard, PoliciesGuard)
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
  async create(@Body() dto: CreateDepartmentDto) {
    const data = await this.departmentsService.create(dto);
    return createApiResponse(data, HttpStatus.CREATED, 'Department created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: Partial<CreateDepartmentDto>) {
    const data = await this.departmentsService.update(id, dto);
    return createApiResponse(data, HttpStatus.OK, 'Department updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async remove(@Param('id', ParseIntPipe) id: number) {
    const data = await this.departmentsService.remove(id);
    return createApiResponse(data, HttpStatus.OK, 'Department deleted successfully');
  }

  // Designations
  @Post(':id/designations')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async createDesignation(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateDesignationDto) {
    const data = await this.departmentsService.createDesignation(id, dto);
    return createApiResponse(data, HttpStatus.CREATED, 'Designation created successfully');
  }

  @Patch(':id/designations/:designationId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async updateDesignation(
    @Param('id', ParseIntPipe) id: number,
    @Param('designationId', ParseIntPipe) designationId: number,
    @Body() dto: Partial<CreateDesignationDto>
  ) {
    const data = await this.departmentsService.updateDesignation(id, designationId, dto);
    return createApiResponse(data, HttpStatus.OK, 'Designation updated successfully');
  }

  @Delete(':id/designations/:designationId')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async removeDesignation(
    @Param('id', ParseIntPipe) id: number,
    @Param('designationId', ParseIntPipe) designationId: number
  ) {
    const data = await this.departmentsService.removeDesignation(id, designationId);
    return createApiResponse(data, HttpStatus.OK, 'Designation deleted successfully');
  }
}
