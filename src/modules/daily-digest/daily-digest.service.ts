import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MailerService } from '../../common/mailer/mailer.service';
import { getTodayKeyKarachi } from '../attendance/student-attendance-status.util';

@Injectable()
export class DailyDigestService {
  private readonly logger = new Logger(DailyDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
  ) {}

  private recipients(): string[] {
    const raw = process.env.DAILY_DIGEST_RECIPIENTS;
    if (!raw) return [];
    return raw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
  }

  async sendDigest(): Promise<void> {
    const to = this.recipients();
    if (to.length === 0) {
      this.logger.warn(
        'DAILY_DIGEST_RECIPIENTS is not set — skipping daily digest',
      );
      return;
    }

    const todayKey = getTodayKeyKarachi();
    const [year, month, day] = todayKey.split('-').map(Number);
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Each figure is read for today and for yesterday, so the email can say
    // how it moved. Day figures compare whole days; backlog figures compare
    // the backlog now with the backlog exactly 24 hours ago.
    const [today, yesterday] = await Promise.all([
      this.dayFigures(year, month, day),
      this.dayFigures(year, month, day - 1),
    ]);
    const [backlogNow, backlogDayAgo] = await Promise.all([
      this.backlogAt(now),
      this.backlogAt(dayAgo),
    ]);

    const dateLabel = now.toLocaleDateString('en-US', {
      timeZone: 'Asia/Karachi',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const money = (n: number) => `Rs ${Math.round(n).toLocaleString('en-US')}`;
    // `higherIsGood` colours the change: more money in is good, a growing
    // queue of tickets or requests is not.
    const metric = (value: number, previous: number, higherIsGood: boolean, display?: string) => ({
      value: display ?? value.toLocaleString('en-US'),
      change: percentChange(value, previous),
      higherIsGood,
    });

    try {
      await this.mailer.sendDailyDigestEmail(to, {
        dateLabel,
        deposits: {
          ...metric(today.depositsTotal, yesterday.depositsTotal, true, money(today.depositsTotal)),
          sub: `${today.depositsCount} deposit${today.depositsCount === 1 ? '' : 's'} · yesterday ${money(yesterday.depositsTotal)}`,
        },
        attendance: [
          { label: 'Employees clocked in', ...metric(today.employeesClockedIn, yesterday.employeesClockedIn, true) },
          { label: 'Employees clocked out', ...metric(today.employeesClockedOut, yesterday.employeesClockedOut, true) },
          { label: 'Students clocked in', ...metric(today.studentsClockedIn, yesterday.studentsClockedIn, true) },
          { label: 'Students clocked out', ...metric(today.studentsClockedOut, yesterday.studentsClockedOut, true) },
        ],
        pending: [
          { label: 'Open support tickets', ...metric(backlogNow.openTickets, backlogDayAgo.openTickets, false) },
          { label: 'Pending leave requests', ...metric(backlogNow.pendingLeave, backlogDayAgo.pendingLeave, false) },
          { label: 'Pending attendance objections', ...metric(backlogNow.pendingObjections, backlogDayAgo.pendingObjections, false) },
        ],
      });
      this.logger.log(`Daily digest sent to ${to.join(', ')}`);
    } catch (error) {
      this.logger.error(
        `Failed to send daily digest: ${(error as Error).message}`,
      );
    }
  }

  /** Deposits and clock-ins/outs for one Karachi calendar day. */
  private async dayFigures(year: number, month: number, day: number) {
    // Deposits use a real timestamp — mirrors FinancialReportsService's
    // day-range convention so this figure matches the Deposits report.
    const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0);
    const dayEnd = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
    // Attendance `date` columns are naive-UTC Karachi wall-clock dates.
    const attendanceDate = new Date(Date.UTC(year, month - 1, day));

    const [
      depositAgg,
      employeesClockedIn,
      employeesClockedOut,
      studentsClockedIn,
      studentsClockedOut,
    ] = await Promise.all([
      this.prisma.deposits.aggregate({
        where: { deposit_date: { gte: dayStart, lt: dayEnd } },
        _sum: { total_amount: true },
        _count: true,
      }),
      this.prisma.attendance_staff_daily.count({
        where: { date: attendanceDate, check_in_at: { not: null } },
      }),
      this.prisma.attendance_staff_daily.count({
        where: { date: attendanceDate, check_out_at: { not: null } },
      }),
      this.prisma.attendance_student_daily.count({
        where: { date: attendanceDate, check_in_at: { not: null } },
      }),
      this.prisma.attendance_student_daily.count({
        where: { date: attendanceDate, check_out_at: { not: null } },
      }),
    ]);

    return {
      depositsTotal: Number(depositAgg._sum.total_amount ?? 0),
      depositsCount: depositAgg._count,
      employeesClockedIn,
      employeesClockedOut,
      studentsClockedIn,
      studentsClockedOut,
    };
  }

  /**
   * What was waiting on staff at instant `at`, rebuilt from timestamps so the
   * same query answers "now" and "24 hours ago":
   * - a support ticket is open if it existed and had not been closed yet;
   * - a leave request or attendance objection is pending if it existed and
   *   had not been reviewed yet.
   */
  private async backlogAt(at: Date) {
    const [openTickets, pendingLeave, pendingObjections] = await Promise.all([
      this.prisma.support_tickets.count({
        where: {
          created_at: { lte: at },
          OR: [
            { closed_at: { gt: at } },
            { closed_at: null, status: { not: 'CLOSED' } },
          ],
        },
      }),
      this.prisma.leave_requests.count({
        where: {
          created_at: { lte: at },
          OR: [{ status: 'PENDING' }, { reviewed_at: { gt: at } }],
        },
      }),
      this.prisma.attendance_objections.count({
        where: {
          created_at: { lte: at },
          OR: [{ status: 'PENDING' }, { reviewed_at: { gt: at } }],
        },
      }),
    ]);
    return { openTickets, pendingLeave, pendingObjections };
  }
}

/**
 * Percentage change from `previous` to `value`, rounded to a whole percent.
 * Null when there is nothing to compare against (yesterday was zero).
 */
export function percentChange(value: number, previous: number): number | null {
  if (previous === 0) return value === 0 ? 0 : null;
  return Math.round(((value - previous) / previous) * 100);
}
