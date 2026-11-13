import {
    Body, Controller, Delete, Get, HttpStatus, Param, ParseIntPipe, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import { RequireAction } from '../../decorators/require-action.decorator';
import { createApiResponse } from '../../utils/serializer.util';
import { Action } from '../auth/casl/actions';
import type { AppAbility } from '../auth/casl/casl-ability.factory';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { UblReconciliationQueryDto, UblSettlementImportDto, UblSettlementPreviewDto } from './dto/ubl-reconciliation.dto';
import { UblReconciliationService } from './ubl-reconciliation.service';

const canReadAnalytics = (ability: AppAbility) => ability.can(Action.Read, 'all') || ability.can(Action.Manage, 'all');
const UPLOAD = FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * UBL Collections tab of Financial Reports: every UBL payment TAFS booked,
 * matched against the settlement statements UBL sends.
 */
@Controller('financial-reports/ubl')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
export class UblReconciliationController {
    constructor(private readonly service: UblReconciliationService) {}

    @Get('reconciliation')
    @CheckPolicies(canReadAnalytics)
    @RequireAction('finance.financial_reports#ubl.view')
    async reconciliation(@Query() query: UblReconciliationQueryDto, @CurrentUser() user: IJwtStaffPayload) {
        const data = await this.service.reconciliation(query, user);
        return createApiResponse(data, HttpStatus.OK, 'UBL reconciliation retrieved successfully');
    }

    @Get('reconciliation/export')
    @CheckPolicies(canReadAnalytics)
    @RequireAction('finance.financial_reports#ubl.view', 'finance.financial_reports#export')
    async exportReconciliation(
        @Query() query: UblReconciliationQueryDto,
        @CurrentUser() user: IJwtStaffPayload,
        @Res() res: Response,
    ) {
        const file = await this.service.exportReconciliation(query, user);
        res.set({
            'Content-Type': file.contentType,
            'Content-Disposition': `attachment; filename="${file.filename}"`,
            'Content-Length': file.buffer.length,
        });
        res.send(file.buffer);
    }

    @Get('settlements')
    @CheckPolicies(canReadAnalytics)
    @RequireAction('finance.financial_reports#ubl.view')
    async listSettlements(@CurrentUser() user: IJwtStaffPayload) {
        const data = await this.service.listImports(user);
        return createApiResponse(data, HttpStatus.OK, 'UBL settlement uploads retrieved successfully');
    }

    @Post('settlements/preview')
    @CheckPolicies(canReadAnalytics)
    @RequireAction('finance.financial_reports#ubl.settlements.manage')
    @UseInterceptors(UPLOAD)
    async previewSettlement(
        @UploadedFile() file: Express.Multer.File,
        @Body() body: UblSettlementPreviewDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const data = await this.service.previewSettlement(file, user, body.sheet, body.header_row);
        return createApiResponse(data, HttpStatus.OK, 'Settlement file read');
    }

    @Post('settlements')
    @CheckPolicies(canReadAnalytics)
    @RequireAction('finance.financial_reports#ubl.settlements.manage')
    @UseInterceptors(UPLOAD)
    async importSettlement(
        @UploadedFile() file: Express.Multer.File,
        @Body() body: UblSettlementImportDto,
        @CurrentUser() user: IJwtStaffPayload,
    ) {
        const data = await this.service.importSettlement(file, body, user);
        return createApiResponse(data, HttpStatus.CREATED, 'Settlement imported');
    }

    @Delete('settlements/:id')
    @CheckPolicies(canReadAnalytics)
    @RequireAction('finance.financial_reports#ubl.settlements.manage')
    async deleteSettlement(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: IJwtStaffPayload) {
        const data = await this.service.deleteImport(id, user);
        return createApiResponse(data, HttpStatus.OK, 'Settlement upload removed');
    }
}
