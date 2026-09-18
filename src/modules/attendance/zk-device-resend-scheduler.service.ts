import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ZkPushService } from './zk-push.service';

/**
 * TRIAL — nightly "re-send today's scans" request to the faculty devices.
 *
 * Why: on 12 Sep 2026 the API was down 05:3x–10:44 PKT. Four devices flushed
 * their queued scans on reconnect; Johar Faculty and GKF Faculty did not, and
 * the morning never arrived. Their device counters showed the scans were
 * stored, just never uploaded.
 *
 * How: queue ADMS `DATA QUERY ATTLOG` for the day. The device picks it up on its
 * next GET getrequest, re-uploads the range through POST cdata, and reports the
 * result to POST devicecmd (logged to zk_push_logs as a `DEVICECMD` row).
 *
 * Why this is safe to replay a whole day:
 *   - scans already stored hit the (device_sn, device_pin, scan_time) unique key
 *     and return before any day rebuild or notification;
 *   - genuinely missing scans are not live (scan_time far from now), so they are
 *     inserted and rebuilt without parent notifications or Coral9 forwarding.
 *
 * Limited to two devices while we find out whether this firmware honours the
 * command. Widen DEVICES (or remove this file) once we know.
 */
const DEVICES: Record<string, string> = {
  NYU7251000240: 'Johar Faculty',
  NYU7261205040: 'GKF Faculty',
};

@Injectable()
export class ZkDeviceResendSchedulerService {
  private readonly logger = new Logger(ZkDeviceResendSchedulerService.name);

  constructor(private readonly zkPushService: ZkPushService) {}

  @Cron('0 23 * * *', { name: 'zk-device-resend-trial', timeZone: 'Asia/Karachi' })
  requestTodaysScans() {
    try {
      // Device clocks run on PKT wall time, so the range is PKT too.
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
      // The protocol separates StartTime and EndTime with a TAB.
      const command = `DATA QUERY ATTLOG StartTime=${today} 00:00:00\tEndTime=${today} 23:59:59`;
      for (const [sn, name] of Object.entries(DEVICES)) {
        this.zkPushService.queueDeviceCommand(sn, command);
        this.logger.log(`Requested re-send of ${today} scans from ${name} (${sn})`);
      }
    } catch (error) {
      this.logger.error(
        `Device re-send request failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
