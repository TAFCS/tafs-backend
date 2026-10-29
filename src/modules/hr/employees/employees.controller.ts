import { EmployeeTimingsService } from './employee-timings.service';
import { EmployeePayService } from './employee-pay.service';
import { auditActorLabel } from '../../../common/utils/audit-actor.util';
import { Controller, Get, Post, Patch, Put, Delete, Body, Param, ParseIntPipe, Query, UseGuards, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { EmployeesService, CreateEmployeeDto, UpdateEmployeeDto, UpdateEmployeeStatusDto, UpdateEmployeeLeavingDateDto, UpdateWorkScheduleDto, UpdateDayTimingsDto, BulkDayTimingDto, TimingsChangeDto, PayChangeDto, UpdateEmployeeAccountDto, ResetEmployeePasswordDto, ChangeEmployeeUsernameDto, ExportEmployeesDto, PreviousEmployerDto } from './employees.service';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../../common/guards/policies.guard';
import { CheckPolicies } from '../../../decorators/check-policies.decorator';
import { RequireAction, RequireAnyAction, RequireAnyTile } from '../../../decorators/require-action.decorator';
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
  constructor(
    private readonly employeesService: EmployeesService,
    private readonly salaryIncrements: SalaryIncrementsService,
    private readonly timings: EmployeeTimingsService,
    private readonly pay: EmployeePayService,
  ) {}

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

  // The employee search box is shared by every page that picks an employee.
  // Open to a holder of ANY of those tiles (an allowlist, not "any staff
  // member"); results stay limited to the caller's scope. The Read Employee
  // policy check is dropped on purpose: a user delegated only one of those
  // tiles does not hold it. Add a tile here when a new page gains an employee
  // search.
  @Get('search-simple')
  @RequireAnyTile(
    'hr.employee_directory',
    'hr.payroll',
    'hr.employee_loans',
    'hr.security_deposits',
    'attendance.academic_calendar',
    'attendance.zk_device_logs',
    'attendance.saturday_schedules',
    'attendance.shift_overrides',
    'attendance.timetables',
    'attendance.teaching_groups',
  )
  async searchSimple(@Query('q') q: string, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.employeesService.searchSimple(q || '', user);
    return createApiResponse(data, HttpStatus.OK, 'Search results retrieved successfully');
  }

  // Lean employee list for the pages that load everyone into a dropdown or a
  // roster (Departments, Payroll test run, the calendar, schedules, timetable
  // slot editor, teaching groups). GET /hr/employees returns the full record
  // (CNIC, pay, phone, schedule), which these tiles must not get just because
  // they need a name to pick. Identity and org fields only, scope-limited.
  @Get('picker')
  @RequireAnyTile(
    'hr.employee_directory',
    'hr.departments',
    'hr.payroll',
    'attendance.academic_calendar',
    'attendance.saturday_schedules',
    'attendance.shift_overrides',
    'attendance.timetables',
    'attendance.teaching_groups',
    // People & Access's Job tab picks a reporting manager (TAFSD-373); it used
    // to load the full employee list, CNIC and pay included, for the names.
    'system.people_access',
  )
  async listPicker(@CurrentUser() user: IJwtStaffPayload) {
    const data = await this.employeesService.listPicker(user);
    return createApiResponse(data, HttpStatus.OK, 'Employees retrieved successfully');
  }

  @Get('day-timings')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.view')
  async listDayTimings(@CurrentUser() user: IJwtStaffPayload) {
    const data = await this.employeesService.listDayTimings(user);
    return createApiResponse(data, HttpStatus.OK, 'Employee day timings retrieved successfully');
  }

  @Post('day-timings/bulk')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.edit')
  async bulkSetDayTiming(@Body() dto: BulkDayTimingDto, @CurrentUser() user: IJwtStaffPayload) {
    // TAFSD-369: through the effective-from path, one employee at a time.
    const ids = [...new Set(dto.employee_ids)];
    for (const id of ids) await this.employeesService.assertCanEdit(id, user);
    const changedBy = auditActorLabel(user) || 'system';
    let updated = 0;
    let scheduled = 0;
    const failed: { employee_id: number; error: string }[] = [];
    const warnings: string[] = [];
    for (const id of ids) {
      try {
        const r = await this.timings.setOneDay(
          id,
          { day_of_week: dto.day_of_week, reporting_time: dto.reporting_time ?? null, leaving_time: dto.leaving_time ?? null },
          dto.effective_from,
          changedBy,
          dto.override_later_changes === true,
        );
        if (r.status === 'APPLIED') updated++;
        if (r.status === 'SCHEDULED') scheduled++;
        warnings.push(...r.warnings);
      } catch (err) {
        failed.push({ employee_id: id, error: (err as Error).message });
      }
    }
    const data = { updated, scheduled, failed, warnings: [...new Set(warnings)] };
    return createApiResponse(data, HttpStatus.OK, `Day timings: ${updated} updated, ${scheduled} scheduled, ${failed.length} failed`);
  }

  // TAFSD-369: timings / working days with an effective-from date.
  @Put(':id/timings')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.edit')
  async changeTimings(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TimingsChangeDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.employeesService.assertCanEdit(id, user);
    const data = await this.timings.changeTimings(id, dto, auditActorLabel(user) || 'system');
    return createApiResponse(data, HttpStatus.OK, data.status === 'SCHEDULED' ? 'Timings change scheduled' : 'Timings updated');
  }

  // TAFSD-372: monthly pay with an effective-from date.
  @Put(':id/pay')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.edit')
  async changePay(@Param('id', ParseIntPipe) id: number, @Body() dto: PayChangeDto, @CurrentUser() user: IJwtStaffPayload) {
    await this.employeesService.assertCanEdit(id, user);
    const data = await this.pay.changePay(id, dto, auditActorLabel(user) || 'system');
    return createApiResponse(data, HttpStatus.OK, data.status === 'SCHEDULED' ? 'Pay change scheduled' : 'Pay updated');
  }

  @Get(':id/pay/scheduled')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.view')
  async listScheduledPay(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    await this.employeesService.assertCanEdit(id, user);
    return createApiResponse(await this.pay.listScheduled(id), HttpStatus.OK, 'Scheduled pay changes');
  }

  @Delete(':id/pay/scheduled/:sid')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.edit')
  async cancelScheduledPay(
    @Param('id', ParseIntPipe) id: number,
    @Param('sid', ParseIntPipe) sid: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.employeesService.assertCanEdit(id, user);
    return createApiResponse(await this.pay.cancelScheduled(id, sid, auditActorLabel(user) || 'system'), HttpStatus.OK, 'Scheduled pay change cancelled');
  }

  @Get(':id/timings/scheduled')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.view')
  async listScheduledTimings(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    await this.employeesService.assertCanEdit(id, user);
    return createApiResponse(await this.timings.listScheduled(id), HttpStatus.OK, 'Scheduled timings changes');
  }

  @Delete(':id/timings/scheduled/:sid')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.edit')
  async cancelScheduledTimings(
    @Param('id', ParseIntPipe) id: number,
    @Param('sid', ParseIntPipe) sid: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    await this.employeesService.assertCanEdit(id, user);
    return createApiResponse(
      await this.timings.cancelScheduled(id, sid, auditActorLabel(user) || 'system'),
      HttpStatus.OK,
      'Scheduled timings change cancelled',
    );
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

  // TAFSD-363: per-weekday timings (Friday).
  @Get(':id/day-timings')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.view')
  async getDayTimings(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.employeesService.getDayTimings(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee day timings retrieved successfully');
  }

  @Put(':id/day-timings')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.edit')
  async updateDayTimings(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDayTimingsDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeesService.updateDayTimings(id, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Employee day timings updated successfully');
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

  @Patch(':id/leaving-date')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#status.change')
  async updateLeavingDate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeLeavingDateDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.employeesService.updateLeavingDate(id, dto, user);
    return createApiResponse(data, HttpStatus.OK, 'Date of leaving updated successfully');
  }

  // Portal-account writes. Beyond the action, a non-super-admin is refused on
  // their own login or a SUPER_ADMIN's, a role above their own access, and
  // credentials of a login that holds more than they do (TAFSD-365).
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
  async salaryIncrementStatus(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) { return createApiResponse(await this.salaryIncrements.employeeStatus(id, user), HttpStatus.OK, 'Salary increment status retrieved'); }

  @Get(':id/salary-increments')
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.view')
  async salaryIncrementHistory(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) { return createApiResponse(await this.salaryIncrements.history(id, user), HttpStatus.OK, 'Salary increment history retrieved'); }

  @Patch(':id/increment-cycle')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#schedule_pay.edit')
  async updateIncrementCycle(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEmployeeIncrementCycleDto, @CurrentUser() user: IJwtStaffPayload) { return createApiResponse(await this.salaryIncrements.updateEmployeeCycle(id, dto.increment_cycle_months ?? null, user), HttpStatus.OK, 'Increment cycle updated'); }

  @Post(':id/previous-employers')
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  @RequireAction('hr.employee_directory#profile.edit')
  async upsertPreviousEmployer(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PreviousEmployerDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const changedBy = user?.username || user?.sub || 'system';
    const data = await this.employeesService.upsertPreviousEmployer(id, dto, changedBy, user);
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
    const data = await this.employeesService.deletePreviousEmployer(id, changedBy, user);
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
  @RequireAnyAction('hr.employee_directory#create', 'hr.register_employee#create')
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
