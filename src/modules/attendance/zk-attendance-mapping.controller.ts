import { Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import {
  CreateDeviceMappingDto,
  SearchPersonsQueryDto,
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
  async getMappings(@CurrentUser() user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    return this.mappingService.getMappings();
  }

  @Get('unmapped')
  async getUnmapped(@CurrentUser() user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    return this.mappingService.getUnmappedPins();
  }

  @Get('search-persons')
  async searchPersons(@Query() query: SearchPersonsQueryDto, @CurrentUser() user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    return this.mappingService.searchPersons(query.type, query.q);
  }

  @Post()
  async createMapping(@Body() dto: CreateDeviceMappingDto, @CurrentUser() user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    return this.mappingService.createMapping(dto, user.sub);
  }

  @Post('simulate-scan')
  async simulateScan(@Body() dto: SimulateScanDto, @CurrentUser() user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);
    return this.mappingService.simulateScan(dto);
  }

  @Patch(':id')
  async updateMapping(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDeviceMappingDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    this.assertSuperAdmin(user);
    return this.mappingService.updateMapping(id, dto);
  }

  private assertSuperAdmin(user: IJwtStaffPayload) {
    if (user.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can manage ZK device mappings');
    }
  }
}
