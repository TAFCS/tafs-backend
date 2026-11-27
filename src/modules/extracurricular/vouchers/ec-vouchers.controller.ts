import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { RequireAction, RequireAnyAction, RequireAnyTile } from '../../../decorators/require-action.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import {
    CreateEcVoucherDto,
    EcIssuableQueryDto,
    EcPdfMergeDto,
    EcPdfPrepareDto,
    EcVoucherFilterDto,
    EcVoucherListQueryDto,
    EcVoucherSearchQueryDto,
    ReissueEcVoucherDto,
    WaiveEcVoucherDto,
} from './dto/ec-vouchers.dto';
import { EcBulkIssueDto, EcBulkIssueFilterDto } from './dto/ec-bulk.dto';
import { EcVoucherBulkService } from './ec-voucher-bulk.service';
import { EcVoucherPdfService } from './ec-voucher-pdf.service';
import { EcVouchersService } from './ec-vouchers.service';

/**
 * TAFSD-605: Extracurricular Fees → Vouchers and Single Voucher (tiles
 * extracurricular.vouchers and extracurricular.single_voucher). Every route has
 * its own action; a new route needs one too (see the MAINTENANCE note in
 * tiles.manifest.ts). Static routes come before `:id`.
 */
@ApiTags('Extracurricular Fees')
@Controller('ec-vouchers')
@UseGuards(JwtStaffGuard, TileActionGuard)
export class EcVouchersController {
    constructor(
        private readonly service: EcVouchersService,
        private readonly pdf: EcVoucherPdfService,
        private readonly bulk: EcVoucherBulkService,
    ) {}

    @Get()
    @ApiOperation({ summary: 'Extracurricular vouchers, paginated, with multi-value filters' })
    @RequireAction('extracurricular.vouchers#view')
    async list(@Query() query: EcVoucherListQueryDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.list(user, query), HttpStatus.OK, 'Extracurricular vouchers fetched');
    }

    @Get('export')
    @ApiOperation({ summary: 'The filtered list as an Excel file' })
    @RequireAction('extracurricular.vouchers#export')
    async export(@Query() query: EcVoucherFilterDto, @CurrentUser() user: IJwtStaffPayload, @Res() res: Response) {
        const buffer = await this.service.exportExcel(user, query);
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="extracurricular-vouchers-${new Date().toISOString().slice(0, 10)}.xlsx"`,
            'Content-Length': buffer.length,
        });
        res.send(buffer);
    }

    @Get('search-simple')
    @ApiOperation({ summary: 'Find vouchers by number or student (empty text finds nothing)' })
    @RequireAnyTile('extracurricular.vouchers', 'extracurricular.single_voucher', 'extracurricular.receive_deposit', 'extracurricular.payment_history')
    async searchSimple(@Query() query: EcVoucherSearchQueryDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.searchSimple(user, query), HttpStatus.OK, 'Extracurricular vouchers found');
    }

    @Get('issuable')
    @ApiOperation({ summary: "A student's unissued charges, and the open vouchers a new one will not include" })
    @RequireAction('extracurricular.single_voucher#view')
    async issuable(@Query() query: EcIssuableQueryDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.issuable(user, query.student_id), HttpStatus.OK, 'Issuable charges fetched');
    }

    @Get('student/:cc')
    @ApiOperation({ summary: "One student's extracurricular vouchers, payments and unissued charges" })
    @RequireAnyAction(
        'extracurricular.vouchers#view',
        'extracurricular.single_voucher#view',
        'extracurricular.receive_deposit#view',
        'extracurricular.payment_history#view',
    )
    async forStudent(@Param('cc', ParseIntPipe) cc: number, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.forStudent(user, cc), HttpStatus.OK, 'Student vouchers fetched');
    }

    @Post('bulk/preview')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Who would get a bulk voucher, and for how much, without issuing anything' })
    @RequireAction('extracurricular.bulk_voucher#view')
    async bulkPreview(@Body() dto: EcBulkIssueFilterDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.bulk.preview(user, dto), HttpStatus.OK, 'Bulk preview');
    }

    @Post('bulk/issue')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Issue one chunk (up to 100 students) of a bulk run' })
    @RequireAction('extracurricular.bulk_voucher#create')
    async bulkIssue(@Body() dto: EcBulkIssueDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.bulk.issue(user, dto), HttpStatus.OK, 'Bulk chunk issued');
    }

    @Post('pdf/prepare')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Make sure up to 25 challans are rendered and stored' })
    @RequireAnyAction('extracurricular.vouchers#download', 'extracurricular.bulk_voucher#create')
    async preparePdfs(@Body() dto: EcPdfPrepareDto, @CurrentUser() user: IJwtStaffPayload) {
        const out: { id: number; url: string; filename: string }[] = [];
        for (const id of [...new Set(dto.ids)]) {
            await this.service.assertVisible(user, id);
            out.push({ id, ...(await this.pdf.ensurePdf(id)) });
        }
        return createApiResponse(out, HttpStatus.OK, 'Challans ready');
    }

    @Post('batch-merge')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Up to 500 challans merged into one PDF' })
    @RequireAnyAction('extracurricular.vouchers#download', 'extracurricular.bulk_voucher#create')
    async batchMerge(@Body() dto: EcPdfMergeDto, @CurrentUser() user: IJwtStaffPayload) {
        const ids = [...new Set(dto.ids)];
        for (const id of ids) await this.service.assertVisible(user, id);
        return createApiResponse(await this.pdf.merge(ids), HttpStatus.OK, 'Challans merged');
    }

    @Get(':id')
    @ApiOperation({ summary: 'One voucher with its lines and payments' })
    @RequireAnyAction(
        'extracurricular.vouchers#view',
        'extracurricular.single_voucher#view',
        'extracurricular.receive_deposit#view',
        'extracurricular.payment_history#view',
        'extracurricular.reports#view',
    )
    async detail(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.detail(user, id), HttpStatus.OK, 'Extracurricular voucher fetched');
    }

    @Post()
    @ApiOperation({ summary: "Issue one voucher from a student's unissued charges" })
    @RequireAction('extracurricular.single_voucher#create')
    async create(@Body() dto: CreateEcVoucherDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.create(user, dto), HttpStatus.CREATED, 'Extracurricular voucher issued');
    }

    @Post(':id/pdf')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'The challan PDF (the stamped receipt once paid)' })
    @RequireAnyAction(
        'extracurricular.vouchers#download',
        'extracurricular.single_voucher#create',
        'extracurricular.receive_deposit#view',
        'extracurricular.payment_history#view',
    )
    async renderPdf(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        await this.service.assertVisible(user, id);
        return createApiResponse(await this.pdf.ensurePdf(id), HttpStatus.OK, 'Challan ready');
    }

    @Post(':id/reissue')
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({ summary: "Put an expired voucher's unpaid part on a fresh voucher with new dates" })
    @RequireAction('extracurricular.vouchers#reissue')
    async reissue(@Param('id', ParseIntPipe) id: number, @Body() dto: ReissueEcVoucherDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.reissue(user, id, dto), HttpStatus.CREATED, 'Voucher reissued');
    }

    @Post(':id/waive')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Write off what is still owed on a voucher, with a reason' })
    @RequireAction('extracurricular.vouchers#waive')
    async waive(@Param('id', ParseIntPipe) id: number, @Body() dto: WaiveEcVoucherDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.waive(user, id, dto), HttpStatus.OK, 'Voucher waived');
    }

    @Post(':id/unwaive')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Undo a waiver' })
    @RequireAction('extracurricular.vouchers#waive')
    async unwaive(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.unwaive(user, id), HttpStatus.OK, 'Waiver undone');
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a voucher with no payments (its charges go back to unissued)' })
    @RequireAction('extracurricular.vouchers#delete')
    async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.remove(user, id), HttpStatus.OK, 'Extracurricular voucher deleted');
    }
}
