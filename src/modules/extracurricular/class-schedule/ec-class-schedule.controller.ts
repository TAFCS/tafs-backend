import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { CopyEcClassScheduleDto, EcClassScheduleQueryDto, UpsertEcClassScheduleDto } from './dto/ec-class-schedule.dto';
import { EcClassScheduleService } from './ec-class-schedule.service';

/**
 * TAFSD-605: Extracurricular Fees → Class Amounts (tile
 * extracurricular.class_schedule). Every route has its own action; a new route
 * needs one too (see the tile's MAINTENANCE note in tiles.manifest.ts).
 */
@ApiTags('Extracurricular Fees')
@Controller('ec-class-fee-schedule')
@UseGuards(JwtStaffGuard, TileActionGuard)
export class EcClassScheduleController {
    constructor(private readonly service: EcClassScheduleService) {}

    @Get()
    @ApiOperation({ summary: "One academic year's extracurricular amounts per class" })
    @RequireAction('extracurricular.class_schedule#view')
    async list(@Query() query: EcClassScheduleQueryDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.list(query, user), HttpStatus.OK, 'Class amounts fetched');
    }

    @Put()
    @ApiOperation({ summary: 'Set or clear class amounts (a batch of grid cells)' })
    @RequireAction('extracurricular.class_schedule#edit')
    async upsert(@Body() dto: UpsertEcClassScheduleDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.upsert(dto, user), HttpStatus.OK, 'Class amounts saved');
    }

    @Post('copy-year')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: "Copy one year's class amounts into another" })
    @RequireAction('extracurricular.class_schedule#copy_year')
    async copyYear(@Body() dto: CopyEcClassScheduleDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.copyYear(dto, user), HttpStatus.OK, 'Class amounts copied');
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Clear one class amount' })
    @RequireAction('extracurricular.class_schedule#edit')
    async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.remove(id, user), HttpStatus.OK, 'Class amount cleared');
    }
}
