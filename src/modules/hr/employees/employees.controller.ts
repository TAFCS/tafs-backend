import { Controller, Get, Post, Patch, Delete, Body, Param, ParseIntPipe, Query, UseGuards, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { EmployeesService, CreateEmployeeDto, UpdateEmployeeDto, UpdateEmployeeStatusDto, UpdateWorkScheduleDto, UpdateEmployeeAccountDto, ResetEmployeePasswordDto, ChangeEmployeeUsernameDto, ExportEmployeesDto, PreviousEmployerDto } from './employees.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { Action } from '../../auth/casl/actions';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createApiResponse } from '../../../utils/serializer.util';
import { SalaryIncrementsService } from '../salary-increments/salary-increments.service';
import { UpdateEmployeeIncrementCycleDto } from '../salary-increments/dto/salary-increments.dto';

@ApiTags('HR Employees')
@ApiBearerAuth()
@Controller('hr/employees')
// TileActionGuard is ADDED to the chain, never a replacement: CASL keeps
// guarding the coarse capability layer, @RequireAction adds the
// sub-permission layer, and both must pass.
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService, private readonly salaryIncrements: SalaryIncrementsService) {}

  @Get('export')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#export')
  async exportExcel(@Query() query: ExportEmployeesDto, @Res() res: Response, @CurrentUser() user: IJwtStaffPayload) {
    const buffer = await this.employeesService.exportExcel(query, user);
    const filename = `employee-directory-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Get('export-master-excel')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#export')
  async exportMasterExcel(@Query() query: ExportEmployeesDto, @Res() res: Response, @CurrentUser() user: IJwtStaffPayload) {
    const buffer = await this.employeesService.exportMasterExcel(query, user);
    const filename = `TAFS_Master_Employee_Database_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Get()
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#view')
  async findAll(@CurrentUser() user: IJwtStaffPayload, @Query('view') view?: string) {
    const data = await this.employeesService.findAll(view === 'summary', user);
    return createApiResponse(data, HttpStatus.OK, 'Employees retrieved successfully');
  }

  @Get('unlinked-users')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#portal.view')
  async findUnlinkedUsers() {
    const data = await this.employeesService.findUnlinkedUsers();
    return createApiResponse(data, HttpStatus.OK, 'Unlinked users retrieved successfully');
  }

  @Get('next-code')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#view')
  async getNextEmployeeCode(@Query('dep') dep?: string) {
    const data = await this.employeesService.getNextEmployeeCode(dep);
    return createApiResponse(data, HttpStatus.OK, 'Next employee code generated');
  }

  @Get('search-simple')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#view')
  async searchSimple(@Query('q') q: string, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.employeesService.searchSimple(q || '', user);
    return createApiResponse(data, HttpStatus.OK, 'Search results retrieved successfully');
  }

  @Get(':id/work-schedule')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.view')
  async getWorkSchedule(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.employeesService.getWorkSchedule(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee work schedule retrieved successfully');
  }

  @Patch(':id/work-schedule')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.edit')
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
  @RequireAction('hr.employee_directory#schedule_pay.edit')
  async clearWorkSchedule(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeesService.clearWorkSchedule(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee work schedule cleared successfully');
  }

  @Patch(':id/status')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#status.change')
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
  @RequireAction('hr.employee_directory#portal.edit')
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
  @RequireAction('hr.employee_directory#portal.reset_password')
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
  @RequireAction('hr.employee_directory#portal.reveal_password')
  async revealAccountPassword(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeesService.revealAccountPassword(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee password revealed successfully');
  }

  @Patch(':id/account/username')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#portal.change_username')
  async changeAccountUsername(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeEmployeeUsernameDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeesService.changeAccountUsername(id, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee username changed successfully');
  }

  @Get(':id/progression')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#progression.view')
  async getProgression(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.employeesService.getProgressionPeriods(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee progression retrieved successfully');
  }

  @Get(':id/salary-increment-status')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.view')
  async salaryIncrementStatus(@Param('id', ParseIntPipe) id: number) { return createApiResponse(await this.salaryIncrements.employeeStatus(id), HttpStatus.OK, 'Salary increment status retrieved'); }

  @Get(':id/salary-increments')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.view')
  async salaryIncrementHistory(@Param('id', ParseIntPipe) id: number) { return createApiResponse(await this.salaryIncrements.history(id), HttpStatus.OK, 'Salary increment history retrieved'); }

  @Patch(':id/increment-cycle')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.edit')
  async updateIncrementCycle(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEmployeeIncrementCycleDto) { return createApiResponse(await this.salaryIncrements.updateEmployeeCycle(id, dto.increment_cycle_months ?? null), HttpStatus.OK, 'Increment cycle updated'); }

  @Post(':id/previous-employers')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#profile.edit')
  async upsertPreviousEmployer(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PreviousEmployerDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const changedBy = user?.username || user?.sub || 'system';
    const data = await this.employeesService.upsertPreviousEmployer(id, dto, changedBy);
    return createApiResponse(data, HttpStatus.OK, 'Previous employer saved successfully');
  }

  @Delete('previous-employers/:id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#profile.edit')
  async deletePreviousEmployer(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const changedBy = user?.username || user?.sub || 'system';
    const data = await this.employeesService.deletePreviousEmployer(id, changedBy);
    return createApiResponse(data, HttpStatus.OK, 'Previous employer deleted successfully');
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#view')
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.employeesService.findOne(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee retrieved successfully');
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#create')
  async create(@Body() dto: CreateEmployeeDto, @CurrentUser() user: IJwtStaffPayload) {
    const changedBy = user?.username || user?.sub || 'system';
    const data = await this.employeesService.create(dto, changedBy, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Employee created successfully');
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  // Only `view` is required at the route: this PATCH writes fields across
  // several tabs, so authorisation happens per field in
  // EmployeesService.assertFieldsEditable against EMPLOYEE_FIELD_TAB_MAP.
  @RequireAction('hr.employee_directory#view')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEmployeeDto, @CurrentUser() user: IJwtStaffPayload) {
    const changedBy = user?.username || user?.sub || 'system';
    const data = await this.employeesService.update(id, dto, changedBy, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee updated successfully');
  }

  @Delete(':id')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#delete')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Query('purge') purge: string | undefined,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const changedBy = user?.username || user?.sub || 'system';
    const data = await this.employeesService.remove(id, changedBy, {
      purge: purge === 'true' || purge === '1',
      caller: user,
    });
    return createApiResponse(
      data,
      HttpStatus.OK,
      purge === 'true' || purge === '1'
        ? 'Employee purged successfully'
        : 'Employee soft-offboarded successfully',
    );
  }
}
