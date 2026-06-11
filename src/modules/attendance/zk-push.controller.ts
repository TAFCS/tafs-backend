import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { GetZkLogsQueryDto } from './dto/zk-push.dto';
import { ZkAttendanceProcessorService } from './zk-attendance-processor.service';
import { ZkPushService } from './zk-push.service';

/**
 * ZK device endpoints — lives at /iclock/* (no api/v1 prefix).
 * The device hits these directly over plain HTTP.
 */
@ApiTags('ZK Device')
@Controller('iclock')
export class ZkDeviceController {
  private readonly logger = new Logger(ZkDeviceController.name);

  constructor(
    private readonly zkPushService: ZkPushService,
    private readonly zkAttendanceProcessor: ZkAttendanceProcessorService,
  ) {}

  // Device checks in on GET — tell it to push attendance logs every 60s
  @Get('cdata')
  @HttpCode(HttpStatus.OK)
  getConfig(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/plain');
    res.send('OK\nDelay=60\n');
  }

  // Device POSTs attendance events — body is tab-separated plain text
  @Post('cdata')
  @HttpCode(HttpStatus.OK)
  async postData(
    @Query() query: Record<string, string>,
    @Body() rawBody: string,
    @Res() res: Response,
  ) {
    const sn = query['SN'] ?? query['sn'] ?? 'unknown';
    const pushLog = await this.zkPushService.handlePush({ sn, query, body: rawBody ?? '' });

    // Don't await: a single push can contain thousands of backfill ATTLOG lines,
    // and the device retries (causing duplicate work) if cdata responds slowly.
    this.zkAttendanceProcessor
      .processPush({ sn, query, body: rawBody ?? '', pushLogId: pushLog?.id ?? null })
      .catch((err) => this.logger.error(`Attendance processing failed for ${sn}: ${err.message}`));

    res.setHeader('Content-Type', 'text/plain');
    res.send('OK\n');
  }

  // Device polls this for pending commands — just acknowledge
  @Get('getrequest')
  @HttpCode(HttpStatus.OK)
  getRequest(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/plain');
    res.send('OK\n');
  }
}

/**
 * Admin logs viewer — lives at /api/v1/attendance/zk-push-logs (JWT protected).
 */
@ApiTags('Attendance ZK Logs')
@ApiBearerAuth()
@Controller('attendance')
@UseGuards(JwtStaffGuard)
export class ZkLogsController {
  constructor(private readonly zkPushService: ZkPushService) {}

  @Get('zk-push-logs')
  async getLogs(@Query() query: GetZkLogsQueryDto, @CurrentUser() user: IJwtStaffPayload) {
    if (user.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can view ZK device logs');
    }

    const [logs, devices] = await Promise.all([
      this.zkPushService.getLogs(query.sn),
      this.zkPushService.getDistinctDevices(),
    ]);
    return { logs, devices };
  }
}
