import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ClassPeriodsService } from './class-periods.service';

@Injectable()
export class TeacherCheckinDerivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly classPeriods: ClassPeriodsService,
  ) {}

  /**
   * Derive expected check-in/out from the earliest start / latest end across
   * the teacher's active slots on the given weekday. Each slot's time comes
   * from its own class's bell schedule (classes can run different period
   * lengths and breaks), so a teacher who teaches across multiple classes in
   * a day has each slot resolved against the right schedule before taking
   * the overall min/max. Returns null when the teacher has no slots that day,
   * or none of those slots have a bell schedule configured yet (caller
   * should fall back to FIXED/policy times).
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
      select: {
        block_number: true,
        timetables: { select: { campus_id: true, class_id: true } },
      },
    });
    if (slots.length === 0) return null;

    const periods = await this.classPeriods.resolveMany(
      slots.map((s) => ({
        campus_id: s.timetables.campus_id,
        class_id: s.timetables.class_id,
        block_number: s.block_number,
      })),
    );

    let checkIn: Date | null = null;
    let checkOut: Date | null = null;
    for (const slot of slots) {
      const period = periods.get(
        `${slot.timetables.campus_id}:${slot.timetables.class_id}:${slot.block_number}`,
      );
      if (!period) continue; // no bell schedule configured for this class yet
      if (!checkIn || period.start_time.getTime() < checkIn.getTime()) checkIn = period.start_time;
      if (!checkOut || period.end_time.getTime() > checkOut.getTime()) checkOut = period.end_time;
    }

    if (!checkIn || !checkOut) return null;
    return { checkIn, checkOut };
  }
}
