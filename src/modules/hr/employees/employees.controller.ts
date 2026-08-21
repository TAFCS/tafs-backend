import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, Query, UseGuards, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { EmployeesService, CreateEmployeeDto, UpdateEmployeeDto, UpdateEmployeeStatusDto, UpdateWorkScheduleDto, UpdateEmployeeAccountDto, ResetEmployeePasswordDto, ChangeEmployeeUsernameDto } from './employees.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { Action } from '../../auth/casl/actions';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';

@ApiTags('HR Employees')
@ApiBearerAuth()
@Controller('hr/employees')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get('export-master-excel')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async exportMasterExcel(@Res() res: Response) {
    const buffer = await this.employeesService.exportMasterExcel();
    const filename = `TAFS_Master_Employee_Database_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

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
  async getNextEmployeeCode(@Query('dep') dep?: string) {
    const data = await this.employeesService.getNextEmployeeCode(dep);
    return createApiResponse(data, HttpStatus.OK, 'Next employee code generated');
  }

  @Get('search-simple')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async searchSimple(@Query('q') q: string) {
    const data = await this.employeesService.searchSimple(q || '');
    return createApiResponse(data, HttpStatus.OK, 'Search results retrieved successfully');
  }

  @Get(':id/work-schedule')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async getWorkSchedule(@Param('id', ParseIntPipe) id: number) {
    const data = await this.employeesService.getWorkSchedule(id);
    return createApiResponse(data, HttpStatus.OK, 'Employee work schedule retrieved successfully');
  }

  @Patch(':id/work-schedule')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async updateWorkSchedule(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateWorkScheduleDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeesService.updateWorkSchedule(id, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee work schedule updated successfully');
  }

  @Delete(':id/work-schedule')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async clearWorkSchedule(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeesService.clearWorkSchedule(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee work schedule cleared successfully');
  }

  @Patch(':id/status')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeStatusDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeesService.updateStatus(id, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee status updated successfully');
  }

  @Patch(':id/account')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async updateAccount(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeAccountDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeesService.updateAccount(id, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee portal account updated successfully');
  }

  @Post(':id/account/reset-password')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async resetAccountPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResetEmployeePasswordDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeesService.resetAccountPassword(id, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee password reset successfully');
  }

  @Get(':id/account/reveal-password')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async revealAccountPassword(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeesService.revealAccountPassword(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee password revealed successfully');
  }

  @Patch(':id/account/username')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async changeAccountUsername(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeEmployeeUsernameDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeesService.changeAccountUsername(id, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee username changed successfully');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const data = await this.employeesService.findOne(id);
    return createApiResponse(data, HttpStatus.OK, 'Employee retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async create(@Body() dto: CreateEmployeeDto, @CurrentUser() user: IJwtStaffPayload) {
    const changedBy = user?.username || user?.sub || 'system';
    const data = await this.employeesService.create(dto, changedBy, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Employee created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEmployeeDto, @CurrentUser() user: any) {
    const changedBy = user?.username || user?.sub || 'system';
    const data = await this.employeesService.update(id, dto, changedBy);
    return createApiResponse(data, HttpStatus.OK, 'Employee updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    const changedBy = user?.username || user?.sub || 'system';
    const data = await this.employeesService.remove(id, changedBy);
    return createApiResponse(data, HttpStatus.OK, 'Employee deleted successfully');
  }
}
