import { Controller, Get, Post, Body, Param, ParseIntPipe, HttpStatus, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TransferService } from './transfer.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { createApiResponse } from '../../utils/serializer.util';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction, RequireAnyAction } from '../../decorators/require-action.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

// This controller shipped with NO guard of any kind: every route, including
// the one that rewrites a student's class, campus and GR number, was reachable
// without a login. It is now authenticated, gated per action, and scoped.
// Search / class picker / GR preview are the tile's `view`; the transfer itself
// is `execute`; the order PDF and its data are `print`.
@ApiTags('transfers')
@Controller('transfers')
@UseGuards(JwtStaffGuard, TileActionGuard)
@RequireAction('student.transfers#view')
export class TransferController {
  constructor(private readonly transferService: TransferService) {}

  @Get(':cc/classes')
  @ApiOperation({ summary: 'Get available classes for the target-class picker based on student mappings' })
  async getClasses(@Param('cc', ParseIntPipe) cc: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.transferService.getAvailableClasses(cc, user);
    return createApiResponse(data, HttpStatus.OK, 'Classes retrieved successfully');
  }

  @Post(':cc/execute')
  @RequireAction('student.transfers#execute')
  @ApiOperation({ summary: 'Execute a student transfer to a new class/academic system' })
  async executeTransfer(
    @Param('cc', ParseIntPipe) cc: number,
    @Body() body: { to_class_id: number; to_campus_id?: number; to_section_id?: number; discipline?: string; remarks?: string; target_academic_year?: string },
    @Req() req: Request,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const changedBy = (req as any).user?.username || (req as any).user?.fullName || 'system';
    const data = await this.transferService.executeTransfer(cc, body, changedBy, user);
    return createApiResponse(data, HttpStatus.OK, 'Transfer executed successfully');
  }

  @Post(':cc/generate-pdf')
  @RequireAction('student.transfers#print')
  @ApiOperation({ summary: 'Generate and upload Transfer Order PDF, returns CDN URL' })
  async generatePdf(
    @Param('cc', ParseIntPipe) cc: number,
    @Body() body: { transfer_from?: string; transfer_to?: string; discipline?: string; remarks?: string; date_of_transfer?: string },
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    const result = await this.transferService.generateTransferPdf(cc, body, user);
    return createApiResponse(result, HttpStatus.OK, 'Transfer order PDF generated successfully');
  }

  @Get('search')
  @ApiOperation({ summary: 'Search students for transfer by name or CC' })
  async search(@Query('q') q: string, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.transferService.searchStudents(q || '', user);
    return createApiResponse(
      data,
      HttpStatus.OK,
      'Transfer student search results retrieved successfully',
    );
  }

  @Get(':cc/preview-gr')
  @ApiOperation({ summary: 'Preview what GR number the student would receive after cross-campus transfer' })
  async previewGr(
    @Param('cc', ParseIntPipe) cc: number,
    @Query('to_campus_id') toCampusId: string,
    @CurrentUser() user: IJwtStaffPayload,
    @Query('to_class_id') toClassId?: string,
  ) {
    const data = await this.transferService.previewTransferGr(
      cc,
      Number(toCampusId),
      toClassId ? Number(toClassId) : undefined,
      user,
    );
    return createApiResponse(data, HttpStatus.OK, 'GR preview retrieved');
  }

  // Also read by the Student Directory's Transfer Order tab, so a directory
  // viewer keeps it without needing the Transfers tile.
  @Get(':cc/transfer-order')
  @RequireAnyAction('student.transfers#print', 'student.directory#view')
  @ApiOperation({ summary: 'Get student data for transfer order PDF' })
  async getTransferOrder(@Param('cc', ParseIntPipe) cc: number, @CurrentUser() user: IJwtStaffPayload) {
    const data = await this.transferService.getTransferOrderData(cc, user);
    return createApiResponse(
      data,
      HttpStatus.OK,
      'Transfer order data retrieved successfully',
    );
  }
}
