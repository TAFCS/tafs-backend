import { RollRecordStatus, AttendanceSource } from '@prisma/client';
import { STUDENT_LATE_MARKING_ENABLED } from './zk-attendance-processor.service';

export function resolveStudentAttendanceStatus(input: {
  dateKey: string;          // YYYY-MM-DD UTC
  todayKey: string;         // YYYY-MM-DD UTC
  isWorkingDay: boolean;
  recordStatus: RollRecordStatus | null;
  recordSource: AttendanceSource | null;
  hasCheckIn: boolean;      // record.check_in_at OR any scan session
  checkInAt?: Date | null;
  expectedCheckIn?: Date | null;
  graceMinutes?: number;
}): RollRecordStatus | null {
  // 1. Non-working day -> EXCUSED
  if (!input.isWorkingDay) {
    return RollRecordStatus.EXCUSED;
  }

  // 2. Use recordStatus if present, except if it is SYSTEM-excused on a working day
  if (input.recordStatus != null) {
    if (
      input.recordStatus === RollRecordStatus.EXCUSED &&
      input.recordSource === AttendanceSource.SYSTEM
    ) {
      // Treat as null / no record
    } else {
      return input.recordStatus;
    }
  }

  // 3. If has check-in scans -> PRESENT or LATE (fallback inference)
  if (input.hasCheckIn) {
    // Student LATE marking is paused campus-wide — see STUDENT_LATE_MARKING_ENABLED.
    if (STUDENT_LATE_MARKING_ENABLED && input.checkInAt && input.expectedCheckIn) {
      const expectedMinutes = input.expectedCheckIn.getUTCHours() * 60 + input.expectedCheckIn.getUTCMinutes();
      const actualMinutes = input.checkInAt.getUTCHours() * 60 + input.checkInAt.getUTCMinutes();
      const grace = input.graceMinutes ?? 0;
      if (actualMinutes > expectedMinutes + grace) {
        return RollRecordStatus.LATE;
      }
    }
    return RollRecordStatus.PRESENT;
  }

  // 4. If past working day and has no check-in -> ABSENT
  if (input.dateKey < input.todayKey && !input.hasCheckIn) {
    return RollRecordStatus.ABSENT;
  }

  // 5. Otherwise -> null (e.g. today or future day with no check-in yet)
  return null;
}

export function getTodayKeyKarachi(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}
