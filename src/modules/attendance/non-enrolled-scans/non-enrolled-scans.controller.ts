import { Controller, Get, HttpStatus, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { TileActionGuard } from '../../../common/guards/tile-action.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import { RequireAction } from '../../../decorators/require-action.decorator';
import { createApiResponse } from '../../../utils/serializer.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { NonEnrolledReportQueryDto } from './non-enrolled-scans.dto';
import { NonEnrolledScansService } from './non-enrolled-scans.service';

/**
 * TAFSD-556: the "Not Enrolled Check-ins" tile (attendance.non_enrolled_check_ins).
 * Default-deny like every web tile. Every route has its own action.
 */
@ApiTags('Attendance - Not Enrolled Check-ins')
@Controller('attendance/non-enrolled-check-ins')
@UseGuards(JwtStaffGuard, TileActionGuard)
export class NonEnrolledScansController {
  constructor(private readonly service: NonEnrolledScansService) {}

  @Get()
  @ApiOperation({ summary: 'Biometric check-ins by students who are not enrolled, one row per student per day' })
  @RequireAction('attendance.non_enrolled_check_ins#view')
  async report(@Query() query: NonEnrolledReportQueryDto, @CurrentUser() user: IJwtStaffPayload) {
    return createApiResponse(await this.service.report(query, user), HttpStatus.OK, 'Not enrolled check-ins fetched');
  }

  @Get('export')
  @ApiOperation({ summary: 'The same report as an Excel file' })
  @RequireAction('attendance.non_enrolled_check_ins#export')
  async export(@Query() query: NonEnrolledReportQueryDto, @CurrentUser() user: IJwtStaffPayload, @Res() res: Response) {
    const buffer = await this.service.exportExcel(query, user);
    const stamp = query.from ?? new Date().toISOString().slice(0, 10);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="not-enrolled-check-ins-${stamp}.xlsx"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  }
}
