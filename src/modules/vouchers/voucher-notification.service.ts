import { Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { ChatGateway } from '../chat/chat.gateway';

const PKT = 'Asia/Karachi';

export const VOUCHER_ALERT_TYPES = {
  VOUCHER_ISSUED: 'VOUCHER_ISSUED',
  DUE_REMINDER_3D: 'DUE_REMINDER_3D',
  DUE_REMINDER_2D: 'DUE_REMINDER_2D',
  DUE_REMINDER_1D: 'DUE_REMINDER_1D',
  BECAME_OVERDUE: 'BECAME_OVERDUE',
  EXPIRY_REMINDER_3D: 'EXPIRY_REMINDER_3D',
  EXPIRY_REMINDER_2D: 'EXPIRY_REMINDER_2D',
  EXPIRY_REMINDER_1D: 'EXPIRY_REMINDER_1D',
} as const;

export type VoucherAlertType = (typeof VOUCHER_ALERT_TYPES)[keyof typeof VOUCHER_ALERT_TYPES];

const DUE_REMINDER_OFFSETS: { days: number; alertType: VoucherAlertType }[] = [
  { days: 3, alertType: VOUCHER_ALERT_TYPES.DUE_REMINDER_3D },
  { days: 2, alertType: VOUCHER_ALERT_TYPES.DUE_REMINDER_2D },
  { days: 1, alertType: VOUCHER_ALERT_TYPES.DUE_REMINDER_1D },
];

const EXPIRY_REMINDER_OFFSETS: { days: number; alertType: VoucherAlertType }[] = [
  { days: 3, alertType: VOUCHER_ALERT_TYPES.EXPIRY_REMINDER_3D },
  { days: 2, alertType: VOUCHER_ALERT_TYPES.EXPIRY_REMINDER_2D },
  { days: 1, alertType: VOUCHER_ALERT_TYPES.EXPIRY_REMINDER_1D },
];

function formatDatePKT(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: PKT,
  }).format(date);
}

/** Wall-clock YYYY-MM-DD in Asia/Karachi for a given instant. */
export function pktDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PKT }).format(date);
}

/** Parse a YYYY-MM-DD key as midnight UTC date (matches @db.Date storage). */
export function dateFromPktKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/** Add calendar days to a PKT date key. */
export function addPktDays(pktKey: string, days: number): string {
  const d = dateFromPktKey(pktKey);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthLabel(month: number | null | undefined): string {
  if (month == null || month < 1 || month > 12) return 'Fee';
  return new Intl.DateTimeFormat('en-GB', { month: 'long' }).format(new Date(2000, month - 1, 1));
}

@Injectable()
export class VoucherNotificationService {
  private readonly logger = new Logger(VoucherNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fcmService: FcmService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,
  ) {}

  async notifyVoucher(
    familyId: number,
    studentCc: number,
    voucherId: number,
    alertType: VoucherAlertType,
    title: string,
    body: string,
  ) {
    const existing = await this.prisma.voucher_notifications.findUnique({
      where: { voucher_id_alert_type: { voucher_id: voucherId, alert_type: alertType } },
    });
    if (existing) return existing;

    const row = await this.prisma.voucher_notifications.create({
      data: {
        family_id: familyId,
        student_cc: studentCc,
        voucher_id: voucherId,
        alert_type: alertType,
        title,
        body,
      },
    });

    await this.fcmService.sendToFamily(familyId, title, body, {
      type: 'voucher_alert',
      voucher_id: String(voucherId),
      student_cc: String(studentCc),
      alert_type: alertType,
      title,
      body,
    });

    try {
      this.chatGateway.broadcastVoucherAlert(familyId, {
        id: row.id,
        voucher_id: row.voucher_id,
        student_cc: row.student_cc,
        alert_type: row.alert_type,
        title: row.title,
        body: row.body,
        created_at: row.created_at,
      });
    } catch (err) {
      this.logger.warn(`[VOUCHER_ALERT] Socket broadcast failed for family ${familyId}: ${err}`);
    }

    return row;
  }

  async sendVoucherIssuedNotification(voucherId: number) {
    const voucher = await this.prisma.vouchers.findUnique({
      where: { id: voucherId },
      include: {
        students: { select: { full_name: true, family_id: true, deleted_at: true } },
      },
    });

    if (!voucher || voucher.status === 'VOID' || voucher.status === 'PAID') {
      return null;
    }

    const familyId = voucher.students?.family_id;
    if (!familyId || voucher.students?.deleted_at) {
      this.logger.warn(`[VOUCHER_ISSUED] Skipped voucher #${voucherId} — no linked family`);
      return null;
    }

    const studentName = voucher.students?.full_name ?? 'Student';
    const label = monthLabel(voucher.month);
    const dueFormatted = formatDatePKT(voucher.due_date);
    const title = `School Fees: ${label}`;
    const body = `Please pay ${studentName}'s ${label} school fees by ${dueFormatted}.`;

    const row = await this.notifyVoucher(
      familyId,
      voucher.student_id,
      voucher.id,
      VOUCHER_ALERT_TYPES.VOUCHER_ISSUED,
      title,
      body,
    );

    this.logger.log(`[VOUCHER_ISSUED] Notified family ${familyId} for voucher #${voucherId}`);
    return row;
  }

  async sendApproachingDueReminders(asOfDate: Date = new Date()) {
    const todayKey = pktDateKey(asOfDate);
    let sent = 0;

    for (const { days, alertType } of DUE_REMINDER_OFFSETS) {
      const targetDueKey = addPktDays(todayKey, days);
      const targetDueDate = dateFromPktKey(targetDueKey);

      const vouchers = await this.prisma.vouchers.findMany({
        where: {
          status: 'UNPAID',
          due_date: targetDueDate,
          students: {
            deleted_at: null,
            family_id: { not: null },
          },
        },
        include: {
          students: { select: { full_name: true, family_id: true, cc: true } },
        },
      });

      for (const voucher of vouchers) {
        const familyId = voucher.students?.family_id;
        if (!familyId) continue;

        const studentName = voucher.students?.full_name ?? 'Student';
        const dueFormatted = formatDatePKT(voucher.due_date);
        const label = monthLabel(voucher.month);
        const title = `Fee Reminder: ${label}`;
        const body = `${studentName}'s ${label} school fees are due on ${dueFormatted}. Please pay on time to avoid late charges.`;

        await this.notifyVoucher(familyId, voucher.student_id, voucher.id, alertType, title, body);
        sent++;
      }
    }

    this.logger.log(`[NOTIF-01] Sent ${sent} approaching-due reminder(s) for PKT date ${todayKey}`);
    return sent;
  }

  async sendApproachingExpiryReminders(asOfDate: Date = new Date()) {
    const todayKey = pktDateKey(asOfDate);
    let sent = 0;

    for (const { days, alertType } of EXPIRY_REMINDER_OFFSETS) {
      const targetValidityKey = addPktDays(todayKey, days);
      const targetValidityDate = dateFromPktKey(targetValidityKey);

      const vouchers = await this.prisma.vouchers.findMany({
        where: {
          status: 'OVERDUE',
          validity_date: targetValidityDate,
          students: {
            deleted_at: null,
            family_id: { not: null },
          },
        },
        include: {
          students: { select: { full_name: true, family_id: true, cc: true } },
        },
      });

      for (const voucher of vouchers) {
        const familyId = voucher.students?.family_id;
        if (!familyId || !voucher.validity_date) continue;

        const studentName = voucher.students?.full_name ?? 'Student';
        const expiryFormatted = formatDatePKT(voucher.validity_date);
        const title = 'Payment Deadline Approaching';
        const body = `${studentName}'s outstanding school fees must be paid by ${expiryFormatted}. Please settle the balance soon.`;

        await this.notifyVoucher(familyId, voucher.student_id, voucher.id, alertType, title, body);
        sent++;
      }
    }

    this.logger.log(`[NOTIF-03] Sent ${sent} approaching-expiry reminder(s) for PKT date ${todayKey}`);
    return sent;
  }

  async sendBecameOverdueForVoucherIds(voucherIds: number[]) {
    if (voucherIds.length === 0) return 0;

    const vouchers = await this.prisma.vouchers.findMany({
      where: {
        id: { in: voucherIds },
        status: 'OVERDUE',
        students: {
          deleted_at: null,
          family_id: { not: null },
        },
      },
      include: {
        students: { select: { full_name: true, family_id: true, cc: true } },
      },
    });

    let sent = 0;
    for (const voucher of vouchers) {
      const familyId = voucher.students?.family_id;
      if (!familyId) continue;

      const studentName = voucher.students?.full_name ?? 'Student';
      const dueFormatted = formatDatePKT(voucher.due_date);
      const label = monthLabel(voucher.month);
      const title = `Fee Overdue: ${label}`;
      const body = `${studentName}'s ${label} school fees were due on ${dueFormatted} and are now overdue. Please pay as soon as possible.`;

      await this.notifyVoucher(
        familyId,
        voucher.student_id,
        voucher.id,
        VOUCHER_ALERT_TYPES.BECAME_OVERDUE,
        title,
        body,
      );
      sent++;
    }

    this.logger.log(`[NOTIF-02] Sent ${sent} became-overdue notification(s)`);
    return sent;
  }

  async getForFamily(familyId: number, cursor?: number) {
    const notifications = await this.prisma.voucher_notifications.findMany({
      where: {
        family_id: familyId,
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { created_at: 'desc' },
      include: {
        students: { select: { full_name: true } },
        vouchers: { select: { due_date: true, validity_date: true, month: true } },
      },
      take: 20,
    });

    return notifications.map((n) => ({
      id: n.id,
      family_id: n.family_id,
      student_cc: n.student_cc,
      voucher_id: n.voucher_id,
      alert_type: n.alert_type,
      title: n.title,
      body: n.body,
      read_at: n.read_at,
      created_at: n.created_at,
      students: n.students,
      vouchers: n.vouchers,
    }));
  }

  async markRead(id: number, familyId: number) {
    const notification = await this.prisma.voucher_notifications.findFirst({
      where: { id, family_id: familyId },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    return this.prisma.voucher_notifications.update({
      where: { id },
      data: { read_at: new Date() },
    });
  }
}
