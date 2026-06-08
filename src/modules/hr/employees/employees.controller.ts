import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, UseGuards, HttpStatus } from '@nestjs/common';
import { EmployeesService, CreateEmployeeDto, UpdateEmployeeDto } from './employees.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { Action } from '../../auth/casl/actions';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';

@ApiTags('HR Employees')
@ApiBearerAuth()
@Controller('hr/employees')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async findAll() {
    const data = await this.employeesService.findAll();
    return createApiResponse(data, HttpStatus.OK, 'Employees retrieved successfully');
  }

  @Get('unlinked-users')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async findUnlinkedUsers() {
    const data = await this.employeesService.findUnlinkedUsers();
    return createApiResponse(data, HttpStatus.OK, 'Unlinked users retrieved successfully');
  }

  @Get('next-code')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async getNextEmployeeCode() {
    const data = await this.employeesService.getNextEmployeeCode();
    return createApiResponse(data, HttpStatus.OK, 'Next employee code generated');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const data = await this.employeesService.findOne(id);
    return createApiResponse(data, HttpStatus.OK, 'Employee retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async create(@Body() dto: CreateEmployeeDto) {
    const data = await this.employeesService.create(dto);
    return createApiResponse(data, HttpStatus.CREATED, 'Employee created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEmployeeDto) {
    const data = await this.employeesService.update(id, dto);
    return createApiResponse(data, HttpStatus.OK, 'Employee updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async remove(@Param('id', ParseIntPipe) id: number) {
    const data = await this.employeesService.remove(id);
    return createApiResponse(data, HttpStatus.OK, 'Employee deleted successfully');
  }
}
