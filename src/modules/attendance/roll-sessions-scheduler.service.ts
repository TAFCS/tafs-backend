import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RollSessionsService } from './roll-sessions.service';

@Injectable()
export class RollSessionsSchedulerService {
  private readonly logger = new Logger(RollSessionsSchedulerService.name);

  constructor(private readonly rollSessionsService: RollSessionsService) {}

  /** Every 15 minutes after 3pm — auto-skip draft A-Level sessions past campus cutoff */
  @Cron('0 */15 15-23 * * *')
  async handleMissedRollCallCutoff() {
    try {
      const count = await this.rollSessionsService.autoSkipMissedSessions();
      if (count > 0) {
        this.logger.log(`Auto-skipped ${count} roll call session(s) past cutoff`);
      }
    } catch (error) {
      this.logger.error(
        `Roll call auto-skip failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
