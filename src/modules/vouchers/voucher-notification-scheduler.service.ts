import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { VoucherNotificationService } from './voucher-notification.service';

@Injectable()
export class VoucherNotificationSchedulerService {
  private readonly logger = new Logger(VoucherNotificationSchedulerService.name);

  constructor(private readonly notificationService: VoucherNotificationService) {}

  /** NOTIF-01 + NOTIF-03: approaching due/expiry reminders at 8am PKT. */
  @Cron('0 8 * * *', { timeZone: 'Asia/Karachi' })
  async handleApproachingReminders() {
    try {
      this.logger.log('[Voucher Notification Scheduler] Running approaching reminders');
      await this.notificationService.sendApproachingDueReminders();
      await this.notificationService.sendApproachingExpiryReminders();
      this.logger.log('[Voucher Notification Scheduler] Approaching reminders completed');
    } catch (error) {
      this.logger.error(
        `[Voucher Notification Scheduler] Error: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }
}
