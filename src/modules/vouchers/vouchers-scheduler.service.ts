import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { VoucherNotificationService } from './voucher-notification.service';
import { dateFromPktKey, pktDateKey } from './voucher-notification.service';

@Injectable()
export class VouchersSchedulerService {
  private readonly logger = new Logger(VouchersSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly voucherNotificationService: VoucherNotificationService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * Cron job that runs at midnight (00:00:00) every day.
   * Updates voucher statuses based on due_date and validity_date:
   * 1. Mark UNPAID vouchers as OVERDUE if due_date has passed
   * 2. Mark UNPAID/OVERDUE vouchers as EXPIRED if validity_date has passed
   * 3. NOTIF-02: notify families when vouchers become overdue
   */
  @Cron('0 0 * * *')
  async handleVoucherStatusUpdate() {
    try {
      const todayKey = pktDateKey(new Date());
      const today = dateFromPktKey(todayKey);

      this.logger.log(`[Voucher Scheduler] Running daily status update at ${today.toISOString()}`);

      const becomingOverdue = await this.prisma.vouchers.findMany({
        where: {
          status: 'UNPAID',
          due_date: { lt: today },
        },
        select: { id: true },
      });
      const overdueIds = becomingOverdue.map((v) => v.id);

      const overdueResult = await this.prisma.vouchers.updateMany({
        where: {
          status: 'UNPAID',
          due_date: { lt: today },
        },
        data: { status: 'OVERDUE' },
      });

      if (overdueResult.count > 0) {
        this.logger.log(`[Voucher Scheduler] Marked ${overdueResult.count} voucher(s) as OVERDUE`);
        await this.voucherNotificationService.sendBecameOverdueForVoucherIds(overdueIds);
        await this.auditLogs.log({
          entity_type: 'VOUCHER',
          entity_id: 'scheduler-overdue',
          action: 'UPDATED',
          field: 'status',
          old_value: 'UNPAID',
          new_value: 'OVERDUE',
          changed_by: 'system',
          note: `Scheduler marked ${overdueResult.count} voucher(s) OVERDUE (todayKey=${todayKey}).`,
        });
      }

      const expiredResult = await this.prisma.vouchers.updateMany({
        where: {
          status: { in: ['UNPAID', 'OVERDUE'] },
          validity_date: { not: null, lt: today },
        },
        data: { status: 'EXPIRED' },
      });

      if (expiredResult.count > 0) {
        this.logger.log(`[Voucher Scheduler] Marked ${expiredResult.count} voucher(s) as EXPIRED due to expired validity_date`);
        await this.auditLogs.log({
          entity_type: 'VOUCHER',
          entity_id: 'scheduler-expired',
          action: 'UPDATED',
          field: 'status',
          old_value: 'UNPAID/OVERDUE',
          new_value: 'EXPIRED',
          changed_by: 'system',
          note: `Scheduler marked ${expiredResult.count} voucher(s) EXPIRED (todayKey=${todayKey}).`,
        });
      }

      this.logger.log(`[Voucher Scheduler] Daily status update completed successfully`);
    } catch (error) {
      this.logger.error(`[Voucher Scheduler] Error during status update: ${(error as Error).message}`, (error as Error).stack);
    }
  }
}
