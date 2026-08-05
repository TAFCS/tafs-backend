import { BadRequestException } from '@nestjs/common';
import { AttendanceSource, RollRecordStatus } from '@prisma/client';
import { StudentAttendanceService } from './student-attendance.service';

describe('StudentAttendanceService.bulkManualMark', () => {
  const makeService = (overrides: Partial<any> = {}) => {
    const prisma = {
      students: { findMany: jest.fn() },
      attendance_student_daily: {
        findMany: jest.fn(),
        upsert: jest.fn(),
      },
      $transaction: jest.fn((promises: Array<Promise<unknown>>) => Promise.all(promises)),
    };

    const calendarResolver = {
      resolveStudentDay: jest.fn(),
    };

    const auditLogs = {
      log: jest.fn().mockResolvedValue(1),
    };

    const service = new StudentAttendanceService(
      { ...prisma, ...overrides.prisma } as any,
      { ...calendarResolver, ...overrides.calendarResolver } as any,
      {} as any, // HolidayAttendanceSyncService
      {} as any, // AttendancePolicyResolverService
      { ...auditLogs, ...(overrides.auditLogs ?? {}) } as any,
      {} as any, // ZkAttendanceProcessorService
    );

    return { service, prisma, calendarResolver, auditLogs };
  };

  it('throws if trying to mark PRESENT on a non-working day (only EXCUSED allowed)', async () => {
    const { service, prisma, calendarResolver } = makeService();

    prisma.students.findMany.mockResolvedValue([
      { cc: 10, class_id: 1, section_id: 1 },
    ]);
    calendarResolver.resolveStudentDay.mockResolvedValue({
      isWorkingDay: false,
      description: 'Holiday',
      dayType: 'HOLIDAY',
      source: 'CALENDAR',
    });
    prisma.attendance_student_daily.findMany.mockResolvedValue([]);

    const dto = {
      date: '2026-06-22',
      campus_id: 1,
      records: [{ student_cc: 10, status: RollRecordStatus.PRESENT }],
    };

    await expect(
      service.bulkManualMark(dto as any, { campusId: 1, sub: 'staff1', username: 'staff1' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('upserts attendance_student_daily with source=MANUAL, status and marked_by', async () => {
    const { service, prisma, calendarResolver } = makeService();

    prisma.students.findMany.mockResolvedValue([
      { cc: 10, class_id: 1, section_id: 1 },
    ]);

    calendarResolver.resolveStudentDay.mockResolvedValue({
      isWorkingDay: false,
      description: 'Holiday',
      dayType: 'HOLIDAY',
      source: 'CALENDAR',
    });

    prisma.attendance_student_daily.findMany.mockResolvedValue([]);
    prisma.attendance_student_daily.upsert.mockResolvedValue({
      student_cc: 10,
    });

    const dto = {
      date: '2026-06-22',
      campus_id: 1,
      records: [{ student_cc: 10, status: RollRecordStatus.EXCUSED }],
    };

    const user = { campusId: 1, sub: 'staff-sub', username: 'staff-name' } as any;

    const result = await service.bulkManualMark(dto as any, user);

    expect(result).toEqual({ saved_count: 1 });
    expect(prisma.attendance_student_daily.upsert).toHaveBeenCalledTimes(1);

    const call = (prisma.attendance_student_daily.upsert as jest.Mock).mock.calls[0][0];
    expect(call.where.student_cc_date.student_cc).toBe(10);
    expect(call.create.status).toBe(RollRecordStatus.EXCUSED);
    expect(call.create.source).toBe(AttendanceSource.MANUAL);
    expect(call.create.marked_by).toBe('staff-sub');
  });
});

