import { Controller, Get, HttpStatus, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { EcOutstandingQueryDto, EcPaymentsQueryDto, EcReportFilterDto } from './dto/ec-reports.dto';
import { EcReportsService } from './ec-reports.service';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * TAFSD-605: Extracurricular Fees → Reports (tile extracurricular.reports).
 * Every route has its own action; a new route needs one too (see the
 * MAINTENANCE note in tiles.manifest.ts).
 */
@ApiTags('Extracurricular Fees')
@Controller('ec-reports')
@UseGuards(JwtStaffGuard, TileActionGuard)
export class EcReportsController {
    constructor(private readonly service: EcReportsService) {}

    private send(res: Response, buffer: Buffer, name: string) {
        res.set({
            'Content-Type': XLSX,
            'Content-Disposition': `attachment; filename="extracurricular-${name}-${new Date().toISOString().slice(0, 10)}.xlsx"`,
            'Content-Length': buffer.length,
        });
        res.send(buffer);
    }

    @Get('summary')
    @ApiOperation({ summary: 'Per head: charged = received + waived + not issued + outstanding + lapsed' })
    @RequireAction('extracurricular.reports#view')
    async summary(@Query() q: EcReportFilterDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.summary(user, q), HttpStatus.OK, 'Summary fetched');
    }

    @Get('summary/export')
    @RequireAction('extracurricular.reports#export')
    async exportSummary(@Query() q: EcReportFilterDto, @CurrentUser() user: IJwtStaffPayload, @Res() res: Response) {
        this.send(res, await this.service.exportSummary(user, q), 'summary');
    }

    @Get('outstanding')
    @ApiOperation({ summary: 'Open and lapsed balances, one row per voucher' })
    @RequireAction('extracurricular.reports#view')
    async outstanding(@Query() q: EcOutstandingQueryDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.outstanding(user, q), HttpStatus.OK, 'Outstanding fetched');
    }

    @Get('outstanding/export')
    @RequireAction('extracurricular.reports#export')
    async exportOutstanding(@Query() q: EcOutstandingQueryDto, @CurrentUser() user: IJwtStaffPayload, @Res() res: Response) {
        this.send(res, await this.service.exportOutstanding(user, q), 'outstanding');
    }

    @Get('payments')
    @ApiOperation({ summary: 'Money received, by the day it was paid, with totals by method and head' })
    @RequireAction('extracurricular.reports#view')
    async payments(@Query() q: EcPaymentsQueryDto, @CurrentUser() user: IJwtStaffPayload) {
        return createApiResponse(await this.service.payments(user, q), HttpStatus.OK, 'Payments fetched');
    }

    @Get('payments/export')
    @RequireAction('extracurricular.reports#export')
    async exportPayments(@Query() q: EcPaymentsQueryDto, @CurrentUser() user: IJwtStaffPayload, @Res() res: Response) {
        this.send(res, await this.service.exportPayments(user, q), 'payments');
    }
}
