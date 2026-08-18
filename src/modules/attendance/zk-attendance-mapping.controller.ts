import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
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
@Controller('attendance/zk-device-mappings')
@UseGuards(JwtStaffGuard)
export class ZkAttendanceMappingController {
  constructor(private readonly mappingService: ZkAttendanceMappingService) {}

  @Get()
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee') || ability.can(Action.Read, 'Student'))
  async getMappings(
    @Query('employee_id') employeeId: string | undefined,
    @Query('student_cc') studentCc: string | undefined,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    if (!employeeId && !studentCc && user.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can list all device mappings');
    }
    const parsedEmployeeId = employeeId ? parseInt(employeeId, 10) : undefined;
    const parsedStudentCc = studentCc ? parseInt(studentCc, 10) : undefined;
    return this.mappingService.getMappings(parsedEmployeeId, parsedStudentCc);
  }

  /** Pre-flight collision check so the UI can warn before submit. */
  @Get('collision-check')
  async collisionCheck(
    @Query('device_sn') deviceSn: string,
    @Query('device_pin') devicePin: string,
    @Query('person_type') personType: string,
    @Query('student_cc') studentCc: string | undefined,
    @Query('employee_id') employeeId: string | undefined,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    this.assertSuperAdmin(user);
    return this.mappingService.checkPinCollisions({
      device_sn: deviceSn,
      device_pin: devicePin,
      person_type: (personType as any) ?? 'STUDENT',
      student_cc: studentCc ? parseInt(studentCc, 10) : undefined,
      employee_id: employeeId ? parseInt(employeeId, 10) : undefined,
    });
  }

  @Get('unmapped')
  async getUnmapped(@CurrentUser() user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    return this.mappingService.getUnmappedPins();
  }

  @Post()
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee') || ability.can(Action.Manage, 'Student'))
  async createMapping(@Body() dto: CreateDeviceMappingDto, @CurrentUser() user: IJwtStaffPayload) {
    return this.mappingService.createMapping(dto, user.sub, auditActorLabel(user));
  }

  @Post('simulate-scan')
  async simulateScan(@Body() dto: SimulateScanDto, @CurrentUser() user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
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
  async deleteMapping(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    return this.mappingService.deleteMapping(id, auditActorLabel(user));
  }

  private assertSuperAdmin(user: IJwtStaffPayload) {
    if (user.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can manage ZK device mappings');
    }
  }
}
