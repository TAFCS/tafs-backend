import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { GetZkLogsQueryDto } from './dto/zk-push.dto';
import { ZkPushService } from './zk-push.service';

/**
 * ZK device endpoints — lives at /iclock/* (no api/v1 prefix).
 * The device hits these directly over plain HTTP.
 */
@ApiTags('ZK Device')
@Controller('iclock')
export class ZkDeviceController {
  constructor(private readonly zkPushService: ZkPushService) {}

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
    await this.zkPushService.handlePush({ sn, query, body: rawBody ?? '' });
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
@UseGuards(JwtStaffGuard, PoliciesGuard)
export class ZkLogsController {
  constructor(private readonly zkPushService: ZkPushService) {}

  @Get('zk-push-logs')
  @CheckPolicies((ability) => ability.can(Action.Read, 'StaffAttendance'))
  async getLogs(@Query() query: GetZkLogsQueryDto) {
    const [logs, devices] = await Promise.all([
      this.zkPushService.getLogs(query.sn),
      this.zkPushService.getDistinctDevices(),
    ]);
    return { logs, devices };
  }
}
