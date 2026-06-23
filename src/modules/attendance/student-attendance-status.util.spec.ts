import { RollRecordStatus, AttendanceSource } from '@prisma/client';
import { resolveStudentAttendanceStatus, getTodayKeyKarachi } from './student-attendance-status.util';

describe('resolveStudentAttendanceStatus', () => {
  const todayKey = '2026-06-23';

  it('past working day with no record and no scans should infer ABSENT', () => {
    const result = resolveStudentAttendanceStatus({
      dateKey: '2026-06-22',
      todayKey,
      isWorkingDay: true,
      recordStatus: null,
      recordSource: null,
      hasCheckIn: false,
    });
    expect(result).toBe(RollRecordStatus.ABSENT);
  });

  it('today with no record and no scans should return null', () => {
    const result = resolveStudentAttendanceStatus({
      dateKey: '2026-06-23',
      todayKey,
      isWorkingDay: true,
      recordStatus: null,
      recordSource: null,
      hasCheckIn: false,
    });
    expect(result).toBeNull();
  });

  it('future working day should return null', () => {
    const result = resolveStudentAttendanceStatus({
      dateKey: '2026-06-24',
      todayKey,
      isWorkingDay: true,
      recordStatus: null,
      recordSource: null,
      hasCheckIn: false,
    });
    expect(result).toBeNull();
  });

  it('past working day with PRESENT record should return PRESENT', () => {
    const result = resolveStudentAttendanceStatus({
      dateKey: '2026-06-22',
      todayKey,
      isWorkingDay: true,
      recordStatus: RollRecordStatus.PRESENT,
      recordSource: AttendanceSource.SYSTEM,
      hasCheckIn: true,
    });
    expect(result).toBe(RollRecordStatus.PRESENT);
  });

  it('non-working day should return EXCUSED', () => {
    const result = resolveStudentAttendanceStatus({
      dateKey: '2026-06-21', // Sunday
      todayKey,
      isWorkingDay: false,
      recordStatus: null,
      recordSource: null,
      hasCheckIn: false,
    });
    expect(result).toBe(RollRecordStatus.EXCUSED);
  });

  it('past working day with scans but no daily row should return PRESENT', () => {
    const result = resolveStudentAttendanceStatus({
      dateKey: '2026-06-22',
      todayKey,
      isWorkingDay: true,
      recordStatus: null,
      recordSource: null,
      hasCheckIn: true,
    });
    expect(result).toBe(RollRecordStatus.PRESENT);
  });

  it('past working day with explicit ABSENT record should return ABSENT', () => {
    const result = resolveStudentAttendanceStatus({
      dateKey: '2026-06-22',
      todayKey,
      isWorkingDay: true,
      recordStatus: RollRecordStatus.ABSENT,
      recordSource: AttendanceSource.STAFF,
      hasCheckIn: false,
    });
    expect(result).toBe(RollRecordStatus.ABSENT);
  });

  it('past working day with SYSTEM-excused record should resolve to ABSENT if no check-in', () => {
    const result = resolveStudentAttendanceStatus({
      dateKey: '2026-06-22',
      todayKey,
      isWorkingDay: true,
      recordStatus: RollRecordStatus.EXCUSED,
      recordSource: AttendanceSource.SYSTEM,
      hasCheckIn: false,
    });
    expect(result).toBe(RollRecordStatus.ABSENT);
  });

  it('past working day with STAFF-excused record should return EXCUSED', () => {
    const result = resolveStudentAttendanceStatus({
      dateKey: '2026-06-22',
      todayKey,
      isWorkingDay: true,
      recordStatus: RollRecordStatus.EXCUSED,
      recordSource: AttendanceSource.STAFF,
      hasCheckIn: false,
    });
    expect(result).toBe(RollRecordStatus.EXCUSED);
  });

  it('past working day with check-in scan before grace limit should return PRESENT', () => {
    const result = resolveStudentAttendanceStatus({
      dateKey: '2026-06-22',
      todayKey,
      isWorkingDay: true,
      recordStatus: null,
      recordSource: null,
      hasCheckIn: true,
      checkInAt: new Date('2026-06-22T08:10:00.000Z'), // 08:10 UTC
      expectedCheckIn: new Date('1970-01-01T08:00:00.000Z'), // 08:00 UTC
      graceMinutes: 15,
    });
    expect(result).toBe(RollRecordStatus.PRESENT);
  });

  it('past working day with check-in scan after grace limit should return LATE', () => {
    const result = resolveStudentAttendanceStatus({
      dateKey: '2026-06-22',
      todayKey,
      isWorkingDay: true,
      recordStatus: null,
      recordSource: null,
      hasCheckIn: true,
      checkInAt: new Date('2026-06-22T08:20:00.000Z'), // 08:20 UTC
      expectedCheckIn: new Date('1970-01-01T08:00:00.000Z'), // 08:00 UTC
      graceMinutes: 15,
    });
    expect(result).toBe(RollRecordStatus.LATE);
  });
});

describe('getTodayKeyKarachi', () => {
  it('correctly maps dates to Asia/Karachi wall-clock YYYY-MM-DD', () => {
    // 2026-06-23 20:00 UTC -> 2026-06-24 01:00 Asia/Karachi
    const d1 = new Date('2026-06-23T20:00:00.000Z');
    expect(getTodayKeyKarachi(d1)).toBe('2026-06-24');

    // 2026-06-23 02:00 UTC -> 2026-06-23 07:00 Asia/Karachi
    const d2 = new Date('2026-06-23T02:00:00.000Z');
    expect(getTodayKeyKarachi(d2)).toBe('2026-06-23');
  });
});
