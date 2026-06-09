import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { CheckPolicies } from '../../decorators/check-policies.decorator';
import { Action } from '../auth/casl/actions';
import { GetZkLogsQueryDto } from './dto/zk-push.dto';
import { ZkPushService } from './zk-push.service';

@ApiTags('Attendance ZK Push')
@Controller('attendance')
export class ZkPushController {
  constructor(private readonly zkPushService: ZkPushService) {}

  /**
   * Endpoint the ZKTeco device POSTs attendance events to (ADMS / TA Push).
   * No authentication — the device cannot send JWT tokens.
   * Always returns { result: 'OK' } or the device will retry endlessly.
   */
  @Post('zk-push')
  @HttpCode(HttpStatus.OK)
  async handleZkPush(@Body() payload: Record<string, unknown>) {
    return this.zkPushService.handlePush(payload);
  }

  @Get('zk-push-logs')
  @ApiBearerAuth()
  @UseGuards(JwtStaffGuard, PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.Read, 'StaffAttendance'))
  async getLogs(@Query() query: GetZkLogsQueryDto) {
    const [logs, devices] = await Promise.all([
      this.zkPushService.getLogs(query.sn),
      this.zkPushService.getDistinctDevices(),
    ]);
    return { logs, devices };
  }
}
