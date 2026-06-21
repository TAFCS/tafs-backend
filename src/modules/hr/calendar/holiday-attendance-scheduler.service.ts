import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HolidayAttendanceSyncService } from './holiday-attendance-sync.service';

@Injectable()
export class HolidayAttendanceSchedulerService {
  private readonly logger = new Logger(HolidayAttendanceSchedulerService.name);

  constructor(private readonly holidaySync: HolidayAttendanceSyncService) {}

  /** Run at UTC midnight — matches existing calendar date-key convention */
  @Cron('5 0 * * *')
  async handleDailyHolidaySyncMidnight() {
    await this.runSync('midnight');
  }

  /** Safety net at 01:00 UTC (~6:00 AM PKT) for holidays added after midnight */
  @Cron('0 1 * * *')
  async handleDailyHolidaySyncMorning() {
    await this.runSync('morning');
  }

  private async runSync(label: string) {
    try {
      await this.holidaySync.syncAllCampusesForToday();
      this.logger.log(`Holiday attendance sync (${label}) completed`);
    } catch (error) {
      this.logger.error(
        `Holiday attendance sync (${label}) failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
