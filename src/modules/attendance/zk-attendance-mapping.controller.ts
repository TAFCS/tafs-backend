import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { ScopeService } from '../../common/scope/scope.service';
import { actionsCover } from '../access/tiles.manifest';
import { Action } from '../auth/casl/actions';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import {
  CreateDeviceMappingDto,
  SimulateScanDto,
  UpdateDeviceMappingDto,
} from './dto/zk-attendance.dto';
import { ZkAttendanceMappingService } from './zk-attendance-mapping.service';

@ApiTags('Attendance ZK Device Mappings')
@ApiBearerAuth()
// The list-everything, collision-check, pin-lookup, unmapped, simulate-scan and
// delete routes were locked to SUPER_ADMIN by a raw role check, so they could
// never be delegated. They now take the ZK Device Logs tile's actions, which no
// role holds by default (the tile has no legacy bridge) and which a SUPER_ADMIN
// grants per role or person. Creating and editing ONE person's mapping is also
// done from the Employee and Student Directory biometric tabs, so those two
// routes keep their policy check and carry no action of this tile.
@Controller('attendance/zk-device-mappings')
@UseGuards(JwtStaffGuard, TileActionGuard)
export class ZkAttendanceMappingController {
  constructor(
    private readonly mappingService: ZkAttendanceMappingService,
    private readonly scope: ScopeService,
  ) {}

  @Get()
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee') || ability.can(Action.Read, 'Student'))
  async getMappings(
    @Query('employee_id') employeeId: string | undefined,
    @Query('student_cc') studentCc: string | undefined,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    // One person's mappings stay open to the directories. Listing EVERY mapping
    // needs the ZK tile's `mappings.view` and an unrestricted caller.
    if (!employeeId && !studentCc) {
      if (!this.scope.isExempt(user) && !actionsCover(user.actions ?? [], 'attendance.zk_device_logs#mappings.view')) {
        throw new ForbiddenException('Missing permission: attendance.zk_device_logs#mappings.view.');
      }
      this.assertUnrestricted(user);
    }
    const parsedEmployeeId = employeeId ? parseInt(employeeId, 10) : undefined;
    const parsedStudentCc = studentCc ? parseInt(studentCc, 10) : undefined;
    return this.mappingService.getMappings(parsedEmployeeId, parsedStudentCc);
  }

  /** Pre-flight collision check so the UI can warn before submit. */
  @Get('collision-check')
  @RequireAction('attendance.zk_device_logs#mappings.view')
  async collisionCheck(
    @Query('device_sn') deviceSn: string,
    @Query('device_pin') devicePin: string,
    @Query('person_type') personType: string,
    @Query('student_cc') studentCc: string | undefined,
    @Query('employee_id') employeeId: string | undefined,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    this.assertUnrestricted(user);
    return this.mappingService.checkPinCollisions({
      device_sn: deviceSn,
      device_pin: devicePin,
      person_type: (personType as any) ?? 'STUDENT',
      student_cc: studentCc ? parseInt(studentCc, 10) : undefined,
      employee_id: employeeId ? parseInt(employeeId, 10) : undefined,
    });
  }

  /**
   * Reverse lookup — "who is device pin X?". The mapping screens are all keyed
   * by person, so a pin seen on a device (or in a mis-credited attendance row)
   * had no way to be traced back to a human without a DB query.
   */
  @Get('pin-lookup')
  @RequireAction('attendance.zk_device_logs#mappings.view')
  async pinLookup(
    @Query('pin') pin: string,
    @Query('device_sn') deviceSn: string | undefined,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    this.assertUnrestricted(user);
    return this.mappingService.lookupPin(pin, deviceSn?.trim() || undefined);
  }

  @Get('unmapped')
  @RequireAction('attendance.zk_device_logs#mappings.view')
  async getUnmapped(@CurrentUser() user: IJwtStaffPayload) {
    this.assertUnrestricted(user);
    return this.mappingService.getUnmappedPins();
  }

  @Post()
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee') || ability.can(Action.Manage, 'Student'))
  async createMapping(@Body() dto: CreateDeviceMappingDto, @CurrentUser() user: IJwtStaffPayload) {
    return this.mappingService.createMapping(dto, user.sub, auditActorLabel(user));
  }

  @Post('simulate-scan')
  @RequireAction('attendance.zk_device_logs#simulate')
  async simulateScan(@Body() dto: SimulateScanDto, @CurrentUser() user: IJwtStaffPayload) {
    this.assertUnrestricted(user);
    return this.mappingService.simulateScan(dto, auditActorLabel(user));
  }

  @Patch(':id')
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee') || ability.can(Action.Manage, 'Student'))
  async updateMapping(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDeviceMappingDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return this.mappingService.updateMapping(id, dto, auditActorLabel(user));
  }

  /**
   * Deletes a mapping and releases every scan it owned, rebuilding the affected
   * daily attendance. Supersedes the ad-hoc delete scripts, which left scans
   * attributed to people who no longer had a mapping.
   */
  @Delete(':id')
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee') || ability.can(Action.Manage, 'Student'))
  @RequireAction('attendance.zk_device_logs#mappings.delete')
  async deleteMapping(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    this.assertUnrestricted(user);
    return this.mappingService.deleteMapping(id, auditActorLabel(user));
  }

  /**
   * These routes reach every campus's devices and scans at once and cannot be
   * cut down per row, so a caller whose data scope is narrowed is refused.
   * SUPER_ADMIN, who holds every action, is never narrowed.
   */
  private assertUnrestricted(user: IJwtStaffPayload) {
    if (!this.scope.isUnrestricted(user)) {
      throw new ForbiddenException('This needs access to every campus, which your data scope does not include');
    }
  }
}
