import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class VouchersSchedulerService {
  private readonly logger = new Logger(VouchersSchedulerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cron job that runs at midnight (00:00:00) every day.
   * Updates voucher statuses based on due_date and validity_date:
   * 1. Mark UNPAID vouchers as OVERDUE if due_date has passed
   * 2. Mark UNPAID/OVERDUE vouchers as EXPIRED if validity_date has passed
   */
  @Cron('0 0 * * *')
  async handleVoucherStatusUpdate() {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      this.logger.log(`[Voucher Scheduler] Running daily status update at ${today.toISOString()}`);

      // 1. Mark vouchers as OVERDUE if due_date has passed and still UNPAID
      const overdueResult = await this.prisma.vouchers.updateMany({
        where: {
          status: 'UNPAID',
          due_date: { lt: today },
        },
        data: { status: 'OVERDUE' },
      });

      if (overdueResult.count > 0) {
        this.logger.log(`[Voucher Scheduler] Marked ${overdueResult.count} voucher(s) as OVERDUE`);
      }

      // 2. Mark vouchers as EXPIRED if validity_date has passed
      const expiredResult = await this.prisma.vouchers.updateMany({
        where: {
          status: { in: ['UNPAID', 'OVERDUE'] },
          validity_date: { not: null, lt: today },
        },
        data: { status: 'EXPIRED' },
      });

      if (expiredResult.count > 0) {
        this.logger.log(`[Voucher Scheduler] Marked ${expiredResult.count} voucher(s) as EXPIRED due to expired validity_date`);
      }

      this.logger.log(`[Voucher Scheduler] Daily status update completed successfully`);
    } catch (error) {
      this.logger.error(`[Voucher Scheduler] Error during status update: ${(error as Error).message}`, (error as Error).stack);
    }
  }
}
