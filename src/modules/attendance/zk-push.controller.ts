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
   * POST /iclock/registry — newer ZKTeco ADMS v2 models (e.g. NYU series, SenseFace)
   * send a registration payload here before entering the normal cdata/getrequest cycle.
   * Body is comma-separated key=value pairs describing device hardware / firmware.
   *
   * The Date header is required: the device uses it to sync its RTC before pushing logs.
   * The response body must be a plain "OK" — anything else (e.g. "GET OPTION FROM: SN")
   * is not a valid ADMS v2 command and causes the device to retry indefinitely.
   * The Stamp acknowledgement comes later in GET /iclock/cdata.
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
    // RFC 1123 Date header — device uses this to sync its real-time clock.
    res.setHeader('Date', new Date().toUTCString());
    res.send('OK\n');
  }

  /**
   * GET /iclock/cdata — device fetches its push configuration after a successful registry.
   *
   * Stamp=0 is critical for devices with LogIDFunOn=1 (e.g. SenseFace 2A): it tells the
   * device to start sending all stored logs from the beginning. Without Stamp, the device
   * never commits to the push phase and loops back to registry instead.
   * Delay=60 sets the push interval in seconds.
   */
  @Get('cdata')
  @HttpCode(HttpStatus.OK)
  async getConfig(@Query() query: Record<string, string>, @Res() res: Response) {
    const sn = query['SN'] ?? query['sn'] ?? 'unknown';
    const options = query['options'] ?? query['Options'] ?? '(none)';
    this.logger.log(`GET cdata: SN=${sn} options=${options} query=${JSON.stringify(query)}`);
    // Log into push_logs table so this cdata call is visible in the admin UI push log viewer.
    await this.zkPushService.handlePush({ sn, query, body: `GET_CDATA options=${options}` });
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Date', new Date().toUTCString());
    // Stamp=0      — ADMS v1 / LogIDFunOn=0 devices: push all logs from start.
    // ATTLOGStamp=0 / OPERLOGStamp=0 — ADMS v2 / LogIDFunOn=1 (e.g. SenseFace 2A):
    //   same intent but the device only recognises the typed stamp fields.
    //   Without these a LogIDFunOn=1 device loops back to registry instead of pushing.
    // TransFlag=TransData AttLog — explicitly tells the device which tables to push.
    // TimeOut=10 — connection timeout in seconds.
    res.send('OK\nStamp=0\nATTLOGStamp=0\nOPERLOGStamp=0\nDelay=60\nTransFlag=TransData AttLog\nTimeOut=10\n');
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
  async getRequest(@Query() query: Record<string, string>, @Res() res: Response) {
    const sn = query['SN'] ?? query['sn'] ?? 'unknown';
    this.logger.log(`GET getrequest: SN=${sn} — device has completed its push cycle`);
    await this.zkPushService.handlePush({ sn, query, body: 'GET_GETREQUEST' });
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
