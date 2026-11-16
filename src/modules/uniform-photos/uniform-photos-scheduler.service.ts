import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { UniformPhotosService } from './uniform-photos.service';

@Injectable()
export class UniformPhotosSchedulerService {
  private readonly logger = new Logger(UniformPhotosSchedulerService.name);

  constructor(private readonly service: UniformPhotosService) {}

  /** TAFSD-527: every morning at 9 AM Pakistan time, while any are pending. */
  @Cron('0 9 * * *', { timeZone: 'Asia/Karachi' })
  async handleDailyReminder() {
    try {
      await this.service.sendDailyReminders();
    } catch (error) {
      this.logger.error(`Uniform photo reminder failed: ${(error as Error).message}`, (error as Error).stack);
    }
  }
}
