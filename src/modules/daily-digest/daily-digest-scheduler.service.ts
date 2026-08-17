import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DailyDigestService } from './daily-digest.service';

@Injectable()
export class DailyDigestSchedulerService {
  private readonly logger = new Logger(DailyDigestSchedulerService.name);

  constructor(private readonly dailyDigestService: DailyDigestService) {}

  /** Every day at 10:00 PM Pakistan Time — email the admin daily digest. */
  @Cron('0 22 * * *', { timeZone: 'Asia/Karachi' })
  async handleDailyDigest() {
    try {
      await this.dailyDigestService.sendDigest();
    } catch (error) {
      this.logger.error(
        `Daily digest scheduler failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
