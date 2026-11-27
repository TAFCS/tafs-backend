import { Body, Controller, Delete, Get, HttpStatus, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { RequireAction, RequireAnyTile } from '../../../decorators/require-action.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { EC_LIVE_TILES } from '../ec.constants';
import {
    CreateEcFeeHeadDto,
    EcFeeHeadListQueryDto,
    EcFeeHeadSearchQueryDto,
    UpdateEcFeeHeadDto,
} from './dto/ec-fee-heads.dto';
import { EcFeeHeadsService } from './ec-fee-heads.service';

/**
 * TAFSD-605: Extracurricular Fees → Fee Heads (tile extracurricular.fee_heads).
 * Every route has its own action; a new route needs one too (see the tile's
 * MAINTENANCE note in tiles.manifest.ts).
 */
@ApiTags('Extracurricular Fees')
@Controller('ec-fee-heads')
@UseGuards(JwtStaffGuard, TileActionGuard)
export class EcFeeHeadsController {
    constructor(private readonly service: EcFeeHeadsService) {}

    @Get()
    @ApiOperation({ summary: 'Extracurricular heads, with how much each is used' })
    @RequireAction('extracurricular.fee_heads#view')
    async list(@Query() query: EcFeeHeadListQueryDto) {
        return createApiResponse(await this.service.list(query), HttpStatus.OK, 'Extracurricular heads fetched');
    }

    @Get('options')
    @ApiOperation({ summary: 'Active heads, for pickers on every extracurricular page' })
    @RequireAnyTile(...EC_LIVE_TILES)
    async options() {
        return createApiResponse(await this.service.options(), HttpStatus.OK, 'Extracurricular heads fetched');
    }

    @Get('search-simple')
    @ApiOperation({ summary: 'Find heads by name (empty text finds nothing)' })
    @RequireAnyTile(...EC_LIVE_TILES)
    async searchSimple(@Query() query: EcFeeHeadSearchQueryDto) {
        return createApiResponse(await this.service.searchSimple(query.q), HttpStatus.OK, 'Extracurricular heads found');
    }

    @Post()
    @ApiOperation({ summary: 'Add an extracurricular head' })
    @RequireAction('extracurricular.fee_heads#create')
    async create(@Body() dto: CreateEcFeeHeadDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.create(dto, user), HttpStatus.CREATED, 'Extracurricular head added');
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Rename, re-schedule, reorder or (de)activate a head' })
    @RequireAction('extracurricular.fee_heads#edit')
    async update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateEcFeeHeadDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        return createApiResponse(await this.service.update(id, dto, user), HttpStatus.OK, 'Extracurricular head saved');
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a head no student is charged for' })
    @RequireAction('extracurricular.fee_heads#delete')
    async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.remove(id, user), HttpStatus.OK, 'Extracurricular head deleted');
    }
}
