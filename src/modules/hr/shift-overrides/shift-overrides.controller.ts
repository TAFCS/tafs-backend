import { Body, Controller, Delete, Get, HttpStatus, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { CreateShiftOverridesDto, ListShiftOverridesQueryDto } from './dto/shift-overrides.dto';
import { ShiftOverridesService } from './shift-overrides.service';

@ApiTags('Employee Shift Overrides')
@ApiBearerAuth()
@Controller('hr/shift-overrides')
@UseGuards(JwtStaffGuard)
export class ShiftOverridesController {
  constructor(private readonly shiftOverridesService: ShiftOverridesService) {}

  @Post()
  async bulkCreate(@Body() dto: CreateShiftOverridesDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.shiftOverridesService.bulkCreate(dto, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Shift override(s) saved successfully');
  }

  @Get()
  async list(@Query() query: ListShiftOverridesQueryDto, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.shiftOverridesService.list(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Shift overrides retrieved successfully');
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.shiftOverridesService.remove(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Shift override deleted successfully');
  }
}
