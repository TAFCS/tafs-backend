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

    const depositsTotal = Number(depositAgg._sum.total_amount ?? 0);
    const dateLabel = new Date().toLocaleDateString('en-US', {
      timeZone: 'Asia/Karachi',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    try {
      await this.mailer.sendDailyDigestEmail(to, {
        dateLabel,
        depositsTotal: `Rs ${Math.round(depositsTotal).toLocaleString('en-US')}`,
        depositsCount: depositAgg._count,
        employeesClockedIn,
        employeesClockedOut,
        studentsClockedIn,
        studentsClockedOut,
      });
      this.logger.log(`Daily digest sent to ${to.join(', ')}`);
    } catch (error) {
      this.logger.error(
        `Failed to send daily digest: ${(error as Error).message}`,
      );
    }
  }
}
