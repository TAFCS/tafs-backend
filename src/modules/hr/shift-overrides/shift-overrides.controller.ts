import { Body, Controller, Delete, Get, HttpStatus, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { RequireAction, RequireAnyAction } from '../../../decorators/require-action.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { CreateShiftOverridesDto, ListShiftOverridesQueryDto } from './dto/shift-overrides.dto';
import { ShiftOverridesService } from './shift-overrides.service';

// This controller had only JwtStaffGuard (no tile or capability check); the
// service restricted writes to SUPER_ADMIN and CAMPUS_ADMIN by role, so the
// list was open to any logged-in staff member. Its API is shared by the Shift
// Overrides page and the shift-overrides tab of the Employee Directory (through
// ShiftHolidayOverridesPanel), so each route accepts either tile's action; the
// service now also accepts a holder of the tile's `manage` action for writes.
@ApiTags('Employee Shift Overrides')
@ApiBearerAuth()
@Controller('hr/shift-overrides')
@UseGuards(JwtStaffGuard, TileActionGuard)
export class ShiftOverridesController {
  constructor(private readonly shiftOverridesService: ShiftOverridesService) {}

  @Post()
  @RequireAnyAction('attendance.shift_overrides#manage', 'hr.employee_directory#shift_overrides.edit')
  async bulkCreate(@Body() dto: CreateShiftOverridesDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.shiftOverridesService.bulkCreate(dto, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Shift override(s) saved successfully');
  }

  @Get()
  @RequireAnyAction('attendance.shift_overrides#view', 'hr.employee_directory#shift_overrides.view')
  async list(@Query() query: ListShiftOverridesQueryDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.shiftOverridesService.list(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Shift overrides retrieved successfully');
  }

  @Delete(':id')
  @RequireAnyAction('attendance.shift_overrides#manage', 'hr.employee_directory#shift_overrides.edit')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.shiftOverridesService.remove(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Shift override deleted successfully');
  }
}
