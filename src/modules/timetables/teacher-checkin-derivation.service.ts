import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class TeacherCheckinDerivationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Derive expected check-in/out from earliest/latest active timetable blocks
   * on the given weekday. Returns null when the teacher has no slots that day
   * (caller should fall back to FIXED/policy times).
   */
  async resolveForDate(
    employeeId: number,
    date: Date,
  ): Promise<{ checkIn: Date; checkOut: Date } | null> {
    const dayOfWeek = date.getUTCDay(); // 0=Sun..6=Sat
    const slots = await this.prisma.timetable_slots.findMany({
      where: {
        employee_id: employeeId,
        day_of_week: dayOfWeek,
        timetables: { is_active: true },
      },
      select: { block_number: true },
    });
    if (slots.length === 0) return null;

    const minBlock = Math.min(...slots.map((s) => s.block_number));
    const maxBlock = Math.max(...slots.map((s) => s.block_number));
    const [startBlock, endBlock] = await Promise.all([
      this.prisma.timetable_blocks.findUniqueOrThrow({ where: { block_number: minBlock } }),
      this.prisma.timetable_blocks.findUniqueOrThrow({ where: { block_number: maxBlock } }),
    ]);

    return { checkIn: startBlock.start_time, checkOut: endBlock.end_time };
  }
}
