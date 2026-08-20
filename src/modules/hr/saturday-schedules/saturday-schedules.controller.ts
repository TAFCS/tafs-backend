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
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import {
  CreateSaturdayScheduleDto,
  ListSaturdaySchedulesQueryDto,
} from './dto/saturday-schedules.dto';
import { SaturdaySchedulesService } from './saturday-schedules.service';

@ApiTags('Saturday Schedules')
@ApiBearerAuth()
@Controller('hr/saturday-schedules')
@UseGuards(JwtStaffGuard)
export class SaturdaySchedulesController {
  constructor(private readonly saturdayService: SaturdaySchedulesService) {}

  @Post()
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

  @Delete(':id')
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
