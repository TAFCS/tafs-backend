import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EmployeeStatus, EmploymentSubtype, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import {
  DEFAULT_PERMANENT_AFTER_MONTHS,
  monthsUntilPermanent,
  permanenceCutoff,
} from '../employees/employment-permanence.util';

@Injectable()
export class PermanentEmployeeScheduler {
  private readonly logger = new Logger(PermanentEmployeeScheduler.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Nightly: ACTIVE employees who have served their department's period
   * (TAFSD-321: Academics and Support Services 12 months, Administration 14,
   * anything else 14) become PERMANENT. employment_subtype is the source of
   * truth (TAFSD-275) and is_permanent_employee — read by leave policy — moves
   * with it.
   *
   * Promote-only: nobody permanent is ever made non-permanent here. Staff
   * with no subtype who haven't served their period yet become NON_PERMANENT
   * (TAFSD-376). CONTRACTUAL and LEFT / TERMINATED staff are never touched.
   */
  @Cron('0 1 * * *')
  async markPermanentEmployees(now: Date = new Date()) {
    const departments = await this.prisma.departments.findMany({ select: { id: true, name: true } });

    // One update per distinct period; the longest period also takes staff with
    // no department or an unmapped one.
    const idsByMonths = new Map<number, number[]>();
    for (const d of departments) {
      const months = monthsUntilPermanent(d.name);
      idsByMonths.set(months, [...(idsByMonths.get(months) ?? []), d.id]);
    }
    if (!idsByMonths.has(DEFAULT_PERMANENT_AFTER_MONTHS)) idsByMonths.set(DEFAULT_PERMANENT_AFTER_MONTHS, []);

    let total = 0;
    for (const [months, departmentIds] of idsByMonths) {
      const inGroup: Prisma.employee_profilesWhereInput =
        months === DEFAULT_PERMANENT_AFTER_MONTHS
          ? { OR: [{ department_id: null }, { department_id: { in: departmentIds } }] }
          : { department_id: { in: departmentIds } };
      const result = await this.prisma.employee_profiles.updateMany({
        where: {
          employment_status: EmployeeStatus.ACTIVE,
          join_date: { lte: permanenceCutoff(months, now) },
          AND: [
            inGroup,
            {
              OR: [
                { employment_subtype: null },
                { employment_subtype: EmploymentSubtype.NON_PERMANENT },
                // Flag drifted out of step with the subtype.
                { employment_subtype: EmploymentSubtype.PERMANENT, is_permanent_employee: false },
              ],
            },
          ],
        },
        data: { employment_subtype: EmploymentSubtype.PERMANENT, is_permanent_employee: true },
      });
      total += result.count;
    }

    // TAFSD-376: anyone still unclassified hasn't served their period yet
    // (the promotions above took everyone who has), so they are NON_PERMANENT.
    const classified = await this.prisma.employee_profiles.updateMany({
      where: { employment_status: EmployeeStatus.ACTIVE, employment_subtype: null },
      data: { employment_subtype: EmploymentSubtype.NON_PERMANENT, is_permanent_employee: false },
    });

    if (total > 0) {
      this.logger.log(`Marked ${total} employees as permanent`);
    }
    if (classified.count > 0) {
      this.logger.log(`Marked ${classified.count} unclassified employees as non-permanent`);
    }
    return total;
  }
}
