import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import {
  CreateSaturdayScheduleDto,
  ListSaturdaySchedulesQueryDto,
  SaturdayGapsQueryDto,
} from './dto/saturday-schedules.dto';
import { SaturdaySchedulesService } from './saturday-schedules.service';

// This controller had only JwtStaffGuard (no tile or capability check); the
// service restricted every route to SUPER_ADMIN and CAMPUS_ADMIN by role, which
// meant a SUPER_ADMIN could never delegate it. Its API is used only by the
// Saturday Schedules page, so `view` is the class-wide default and create /
// remove take `manage`; the service now also accepts a holder of that action.
@ApiTags('Saturday Schedules')
@ApiBearerAuth()
@Controller('hr/saturday-schedules')
@UseGuards(JwtStaffGuard, TileActionGuard)
@RequireAction('attendance.saturday_schedules#view')
export class SaturdaySchedulesController {
  constructor(private readonly saturdayService: SaturdaySchedulesService) {}

  @Post()
  @RequireAction('attendance.saturday_schedules#manage')
  async create(
    @Body() dto: CreateSaturdayScheduleDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.saturdayService.create(dto, user);
    return createApiResponse(
      data,
      HttpStatus.CREATED,
      'Saturday schedule created successfully',
    );
  }

  @Get()
  async list(
    @Query() query: ListSaturdaySchedulesQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.saturdayService.list(query, user);
    return createApiResponse(
      data,
      HttpStatus.OK,
      'Saturday schedules retrieved successfully',
    );
  }

  // TAFSD-445: Saturdays this employee's segment works that they aren't marked for.
  @Get('suggestions/:employeeId')
  async suggestions(
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.saturdayService.suggestionsFor(employeeId, user);
    return createApiResponse(data, HttpStatus.OK, 'Saturday suggestions retrieved successfully');
  }

  // TAFSD-445: employees with no working Saturday in a cycle their segment works.
  @Get('gaps')
  async gaps(
    @Query() query: SaturdayGapsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.saturdayService.gaps(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Saturday gaps retrieved successfully');
  }

  @Delete(':id')
  @RequireAction('attendance.saturday_schedules#manage')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.saturdayService.remove(id, user);
    return createApiResponse(
      data,
      HttpStatus.OK,
      'Saturday schedule deleted successfully',
    );
  }
}
