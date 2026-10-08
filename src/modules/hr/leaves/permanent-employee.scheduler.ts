import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EmployeeStatus, EmploymentSubtype } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';

/** Months of service after which an active employee becomes permanent. */
export const PERMANENT_AFTER_MONTHS = 14;

@Injectable()
export class PermanentEmployeeScheduler {
  private readonly logger = new Logger(PermanentEmployeeScheduler.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Nightly: ACTIVE employees who joined at least 14 months ago become
   * PERMANENT. employment_subtype is the source of truth (TAFSD-275) and
   * is_permanent_employee — read by leave policy — moves with it.
   * LEFT / TERMINATED staff are not touched.
   */
  @Cron('0 1 * * *')
  async markPermanentEmployees(now: Date = new Date()) {
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - PERMANENT_AFTER_MONTHS);
    cutoff.setUTCHours(0, 0, 0, 0);

    const result = await this.prisma.employee_profiles.updateMany({
      where: {
        employment_status: EmployeeStatus.ACTIVE,
        join_date: { lte: cutoff },
        OR: [
          { employment_subtype: null },
          { employment_subtype: { not: EmploymentSubtype.PERMANENT } },
          { is_permanent_employee: false },
        ],
      },
      data: { employment_subtype: EmploymentSubtype.PERMANENT, is_permanent_employee: true },
    });

    if (result.count > 0) {
      this.logger.log(`Marked ${result.count} employees as permanent`);
    }
    return result.count;
  }
}
