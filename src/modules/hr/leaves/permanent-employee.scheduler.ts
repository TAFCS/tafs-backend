import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../../prisma/prisma.service';

@Injectable()
export class PermanentEmployeeScheduler {
  private readonly logger = new Logger(PermanentEmployeeScheduler.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron('0 1 * * *')
  async markPermanentEmployees() {
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 14);
    cutoff.setUTCHours(0, 0, 0, 0);

    const result = await this.prisma.employee_profiles.updateMany({
      where: {
        join_date: { lte: cutoff },
        is_permanent_employee: false,
      },
      data: { is_permanent_employee: true },
    });

    if (result.count > 0) {
      this.logger.log(`Marked ${result.count} employees as permanent`);
    }
  }
}
