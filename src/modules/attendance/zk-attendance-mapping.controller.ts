import { Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
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
  @CheckPolicies((ability) => ability.can(Action.Read, 'Employee'))
  async getMappings(
    @Query('employee_id') employeeId: string | undefined,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    if (!employeeId && user.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can list all device mappings');
    }
    const parsed = employeeId ? parseInt(employeeId, 10) : undefined;
    return this.mappingService.getMappings(parsed);
  }

  @Get('unmapped')
  async getUnmapped(@CurrentUser() user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    return this.mappingService.getUnmappedPins();
  }

  @Post()
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async createMapping(@Body() dto: CreateDeviceMappingDto, @CurrentUser() user: IJwtStaffPayload) {
    return this.mappingService.createMapping(dto, user.sub);
  }

  @Post('simulate-scan')
  async simulateScan(@Body() dto: SimulateScanDto, @CurrentUser() user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    return this.mappingService.simulateScan(dto);
  }

  @Patch(':id')
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Manage, 'Employee'))
  async updateMapping(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDeviceMappingDto,
  ) {
    return this.mappingService.updateMapping(id, dto);
  }

  private assertSuperAdmin(user: IJwtStaffPayload) {
    if (user.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can manage ZK device mappings');
    }
  }
}
