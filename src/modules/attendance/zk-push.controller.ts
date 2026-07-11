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
 * ZK device endpoints — lives at /api/v1/iclock/*.
 * The device hits these directly over plain HTTP.
 *
 * Endpoint map:
 *   POST registry    — newer ADMS v2 models (NYU series etc.) register here first.
 *   GET  cdata       — device asks for its config / push interval.
 *   POST cdata       — device pushes attendance logs (tab-separated plain text).
 *   GET  getrequest  — device polls for pending server commands.
 *   POST devicecmd   — newer models ack command execution here.
 */
@ApiTags('ZK Device')
@Controller('iclock')
export class ZkDeviceController {
  private readonly logger = new Logger(ZkDeviceController.name);

  constructor(
    private readonly zkPushService: ZkPushService,
    private readonly zkAttendanceProcessor: ZkAttendanceProcessorService,
  ) {}

  /**
   * POST /iclock/registry — newer ZKTeco ADMS v2 models (e.g. NYU series) send
   * a registration payload here before entering the normal cdata/getrequest cycle.
   * Body is comma-separated key=value pairs describing device hardware / firmware.
   * We log it exactly like a regular cdata push so the SN appears in our device list.
   */
  @Post('registry')
  @HttpCode(HttpStatus.OK)
  async postRegistry(
    @Query() query: Record<string, string>,
    @Body() rawBody: string,
    @Res() res: Response,
  ) {
    const sn = query['SN'] ?? query['sn'] ?? 'unknown';
    this.logger.log(`Device registry: SN=${sn} payload=${(rawBody ?? '').slice(0, 200)}`);
    // Log into the same zk_push_logs table so the device shows up in the admin UI.
    await this.zkPushService.handlePush({ sn, query, body: rawBody ?? '' });
    res.setHeader('Content-Type', 'text/plain');
    res.send('OK\n');
  }

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

  /**
   * POST /iclock/devicecmd — newer ADMS v2 firmware sends command-execution
   * acknowledgements here instead of (or in addition to) getrequest.
   * Just acknowledge so the device doesn't retry.
   */
  @Post('devicecmd')
  @HttpCode(HttpStatus.OK)
  postDeviceCmd(
    @Query() query: Record<string, string>,
    @Body() rawBody: string,
    @Res() res: Response,
  ) {
    const sn = query['SN'] ?? query['sn'] ?? 'unknown';
    this.logger.debug(`devicecmd ack from SN=${sn}: ${(rawBody ?? '').slice(0, 200)}`);
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
