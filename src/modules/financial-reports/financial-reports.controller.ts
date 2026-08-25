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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import type { AppAbility } from '../auth/casl/casl-ability.factory';
import { createApiResponse } from '../../utils/serializer.util';
import { FinancialReportsService } from './financial-reports.service';
import {
  ExportDepositsQueryDto,
  ExportFeeHeadsQueryDto,
  ExportFeeMatrixQueryDto,
  ListDepositsQueryDto,
  ListFeeHeadsQueryDto,
  ListFeeMatrixQueryDto,
} from './dto/financial-report-query.dto';
import {
  CreateFeeHeadsSnapshotDto,
  ListFeeHeadsSnapshotsQueryDto,
} from './dto/financial-report-snapshot.dto';

const canReadAnalytics = (ability: AppAbility) =>
  ability.can(Action.Read, 'all') || ability.can(Action.Manage, 'all');

const canFinalizeAnalytics = (ability: AppAbility) =>
  ability.can(Action.Manage, 'all');

@Controller('financial-reports')
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class FinancialReportsController {
  constructor(private readonly financialReportsService: FinancialReportsService) {}

  @Get('filter-options')
  @CheckPolicies(canReadAnalytics)
  async filterOptions() {
    const data = await this.financialReportsService.listFilterOptions();
    return createApiResponse(data, HttpStatus.OK, 'Financial report filters retrieved successfully');
  }

  @Get('fee-heads/snapshots')
  @CheckPolicies(canReadAnalytics)
  async listFeeHeadsSnapshots(
    @Query() query: ListFeeHeadsSnapshotsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.financialReportsService.listFeeHeadsSnapshots(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Fee heads snapshots retrieved successfully');
  }

  @Post('fee-heads/snapshots')
  @CheckPolicies(canReadAnalytics)
  async createFeeHeadsSnapshot(
    @Body() dto: CreateFeeHeadsSnapshotDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.financialReportsService.createFeeHeadsSnapshot(dto, user);
    return createApiResponse(data, HttpStatus.CREATED, 'Fee heads snapshot created successfully');
  }

  @Get('fee-heads/snapshots/:id')
  @CheckPolicies(canReadAnalytics)
  async getFeeHeadsSnapshot(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.financialReportsService.getFeeHeadsSnapshot(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Fee heads snapshot retrieved successfully');
  }

  @Post('fee-heads/snapshots/:id/finalize')
  @CheckPolicies(canFinalizeAnalytics)
  async finalizeFeeHeadsSnapshot(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.financialReportsService.finalizeFeeHeadsSnapshot(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Fee heads snapshot finalized successfully');
  }

  @Delete('fee-heads/snapshots/:id')
  @CheckPolicies(canReadAnalytics)
  async deleteFeeHeadsSnapshot(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.financialReportsService.deleteFeeHeadsSnapshot(id, user);
    return createApiResponse(data, HttpStatus.OK, 'Fee heads snapshot deleted successfully');
  }

  @Get('fee-heads')
  @CheckPolicies(canReadAnalytics)
  async listFeeHeads(
    @Query() query: ListFeeHeadsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.financialReportsService.listFeeHeads(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Fee heads report retrieved successfully');
  }

  @Get('fee-heads/export')
  @CheckPolicies(canReadAnalytics)
  async exportFeeHeads(
    @Query() query: ExportFeeHeadsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
    @Res() res: Response,
  ) {
    const file = await this.financialReportsService.exportFeeHeads(query, user);
    this.sendFile(res, file);
  }

  @Get('deposits')
  @CheckPolicies(canReadAnalytics)
  async listDeposits(
    @Query() query: ListDepositsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.financialReportsService.listDeposits(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Deposits report retrieved successfully');
  }

  @Get('deposits/export')
  @CheckPolicies(canReadAnalytics)
  async exportDeposits(
    @Query() query: ExportDepositsQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
    @Res() res: Response,
  ) {
    const file = await this.financialReportsService.exportDeposits(query, user);
    this.sendFile(res, file);
  }

  @Get('fee-matrix')
  @CheckPolicies(canReadAnalytics)
  async listFeeMatrix(
    @Query() query: ListFeeMatrixQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const data = await this.financialReportsService.listFeeMatrix(query, user);
    return createApiResponse(data, HttpStatus.OK, 'Fee matrix report retrieved successfully');
  }

  @Get('fee-matrix/export')
  @CheckPolicies(canReadAnalytics)
  async exportFeeMatrix(
    @Query() query: ExportFeeMatrixQueryDto,
    @CurrentUser() user: IJwtStaffPayload,
    @Res() res: Response,
  ) {
    const file = await this.financialReportsService.exportFeeMatrix(query, user);
    this.sendFile(res, file);
  }

  private sendFile(
    res: Response,
    file: { buffer: Buffer; filename: string; contentType: string },
  ): void {
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Content-Length': file.buffer.length,
    });
    res.send(file.buffer);
  }
}
