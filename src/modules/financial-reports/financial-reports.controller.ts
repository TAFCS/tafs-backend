import {
  Controller,
  Get,
  HttpStatus,
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
  ListDepositsQueryDto,
  ListFeeHeadsQueryDto,
} from './dto/financial-report-query.dto';

const canReadAnalytics = (ability: AppAbility) =>
  ability.can(Action.Read, 'all') || ability.can(Action.Manage, 'all');

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
