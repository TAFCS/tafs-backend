import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { RequireAction } from '../../decorators/require-action.decorator';
import { createApiResponse } from '../../utils/serializer.util';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import {
    FamilyCreditAdjustDto,
    FamilyCreditListQueryDto,
    FamilyCreditRefundDto,
    FamilyCreditSearchQueryDto,
    FamilyCreditTransferDto,
    FamilyCreditUndoDto,
} from './dto/family-credit.dto';
import { FamilyCreditService } from './family-credit.service';

/**
 * TAFSD-504: the Family Credit tile (finance.family_credit). Every route has its
 * own action; new routes need one too (see the tile's MAINTENANCE note).
 */
@ApiTags('Family Credit')
@Controller('family-credit')
@UseGuards(JwtStaffGuard, TileActionGuard)
export class FamilyCreditController {
    constructor(private readonly service: FamilyCreditService) {}

    @Get()
    @ApiOperation({ summary: 'Families holding credit, with balance and last movement' })
    @RequireAction('finance.family_credit#view')
    async list(@Query() query: FamilyCreditListQueryDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.list(query, user), HttpStatus.OK, 'Family credit fetched');
    }

    @Get('search-simple')
    @ApiOperation({ summary: 'Find any family you can see by number, name, legacy id or a student in it' })
    @RequireAction('finance.family_credit#view')
    async searchSimple(@Query() query: FamilyCreditSearchQueryDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(
            await this.service.searchSimple(query.q, user, query.campus_ids ?? []),
            HttpStatus.OK,
            'Families found',
        );
    }

    @Get('export')
    @ApiOperation({ summary: 'The filtered list as an Excel file' })
    @RequireAction('finance.family_credit#export')
    async export(
        @Query() query: FamilyCreditListQueryDto,
        @CurrentUser() user: IJwtStaffPayload,
        @Res() res: Response,
    ) {
        const buffer = await this.service.exportExcel(query, user);
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="family-credit-${new Date().toISOString().slice(0, 10)}.xlsx"`,
            'Content-Length': buffer.length,
        });
        res.send(buffer);
    }

    @Get(':familyId')
    @ApiOperation({ summary: "A family's balance and full ledger, newest first" })
    @RequireAction('finance.family_credit#view')
    async detail(@Param('familyId', ParseIntPipe) familyId: number, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.detail(familyId, user), HttpStatus.OK, 'Family credit fetched');
    }

    @Post(':familyId/add')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Add credit to a family (+)' })
    @RequireAction('finance.family_credit#add')
    async add(
        @Param('familyId', ParseIntPipe) familyId: number,
        @Body() dto: FamilyCreditAdjustDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const data = await this.service.addCredit(familyId, dto.amount, dto.reason, user);
        return createApiResponse(data, HttpStatus.OK, 'Credit added');
    }

    @Post(':familyId/deduct')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Deduct credit from a family (-). Never below zero.' })
    @RequireAction('finance.family_credit#deduct')
    async deduct(
        @Param('familyId', ParseIntPipe) familyId: number,
        @Body() dto: FamilyCreditAdjustDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const data = await this.service.deductCredit(familyId, dto.amount, dto.reason, user);
        return createApiResponse(data, HttpStatus.OK, 'Credit deducted');
    }

    @Post(':familyId/refund')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Record credit paid back to the family. Never below zero.' })
    @RequireAction('finance.family_credit#refund')
    async refund(
        @Param('familyId', ParseIntPipe) familyId: number,
        @Body() dto: FamilyCreditRefundDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const data = await this.service.refundCredit(familyId, dto.amount, dto.method, dto.reason, user);
        return createApiResponse(data, HttpStatus.OK, 'Refund recorded');
    }

    @Post(':familyId/transfer')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Move credit to another family' })
    @RequireAction('finance.family_credit#transfer')
    async transfer(
        @Param('familyId', ParseIntPipe) familyId: number,
        @Body() dto: FamilyCreditTransferDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const data = await this.service.transferCredit(familyId, dto.to_family_id, dto.amount, dto.reason, user);
        return createApiResponse(data, HttpStatus.OK, 'Credit moved');
    }

    @Post('entries/:entryId/undo')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Undo a manual entry with an opposite row' })
    @RequireAction('finance.family_credit#undo')
    async undo(
        @Param('entryId', ParseIntPipe) entryId: number,
        @Body() dto: FamilyCreditUndoDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const data = await this.service.undoEntry(entryId, dto.reason, user);
        return createApiResponse(data, HttpStatus.OK, 'Entry undone');
    }
}
