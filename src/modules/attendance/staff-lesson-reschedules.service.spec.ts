import { describe, expect, it, jest } from '@jest/globals';
import { StaffLessonExcuseService } from './staff-lesson-excuse.service';
import { StaffLessonReschedulesService } from './staff-lesson-reschedules.service';

describe('StaffLessonExcuseService', () => {
  const makeService = () => {
    const prisma = {
      timetable_slots: { count: jest.fn().mockResolvedValue(0) },
      employee_profiles: {
        findUnique: jest.fn().mockResolvedValue({ campus_id: 1 }),
      },
      attendance_staff_daily: { upsert: jest.fn().mockResolvedValue({}) },
    };
    return { service: new StaffLessonExcuseService(prisma as any), prisma };
  };

  it('writes EXCUSED on staff register', async () => {
    const { service, prisma } = makeService();
    const result = await service.excuseTeacherForMissedLesson({
      employeeId: 10,
      sourceDate: new Date('2026-09-01T00:00:00.000Z'),
      makeupDate: new Date('2026-09-06T00:00:00.000Z'),
      sourceSlotId: 100,
      campusId: 1,
    });
    expect(result.staffExcused).toBe(true);
    expect(prisma.attendance_staff_daily.upsert).toHaveBeenCalled();
  });

  it('warns when teacher has other slots same weekday', async () => {
    const { service, prisma } = makeService();
    prisma.timetable_slots.count = jest.fn().mockResolvedValue(2);
    const result = await service.excuseTeacherForMissedLesson({
      employeeId: 10,
      sourceDate: new Date('2026-09-01T00:00:00.000Z'),
      makeupDate: new Date('2026-09-06T00:00:00.000Z'),
      sourceSlotId: 100,
    });
    expect(result.staffExcused).toBe(false);
    expect(result.staffExcuseWarning).toContain('other timetable slots');
    expect(prisma.attendance_staff_daily.upsert).not.toHaveBeenCalled();
  });
});

describe('StaffLessonReschedulesService', () => {
  it('complete does not touch roll records', async () => {
    const prisma = {
      staff_lesson_reschedules: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          status: 'SCHEDULED',
          employee_id: 10,
          campus_id: 1,
          class_id: 12,
          section_id: 1,
          source_date: new Date('2026-09-01T00:00:00.000Z'),
          makeup_date: new Date('2026-09-06T00:00:00.000Z'),
          source_timetable_slot_id: 100,
          employee_profiles: { id: 10, full_name: 'T', employee_code: 'X' },
          classes: { id: 12, class_code: 'OI', description: 'O I' },
          sections: { id: 1, description: 'A' },
          source_timetable_slot: {
            id: 100,
            day_of_week: 1,
            block_number: 1,
            subjects: { id: 1, name: 'Math', code: 'M' },
          },
          makeup_timetable_slot: null,
          users: null,
        }),
        update: jest.fn().mockImplementation(({ where, data }) => ({
          id: where.id,
          status: data.status,
          employee_id: 10,
          campus_id: 1,
          class_id: 12,
          section_id: 1,
          source_date: new Date('2026-09-01T00:00:00.000Z'),
          makeup_date: new Date('2026-09-06T00:00:00.000Z'),
          source_timetable_slot_id: 100,
          employee_profiles: { id: 10, full_name: 'T', employee_code: 'X' },
          classes: { id: 12, class_code: 'OI', description: 'O I' },
          sections: { id: 1, description: 'A' },
          source_timetable_slot: {
            id: 100,
            day_of_week: 1,
            block_number: 1,
            subjects: { id: 1, name: 'Math', code: 'M' },
          },
          makeup_timetable_slot: null,
          users: null,
        })),
      },
      attendance_roll_records: { upsert: jest.fn() },
    };

    const staffExcuse = {
      excuseTeacherForMissedLesson: jest.fn().mockResolvedValue({
        staffExcused: true,
        staffExcuseWarning: null,
      }),
      formatDateLabel: (d: Date) => d.toISOString().slice(0, 10),
    };

    const service = new StaffLessonReschedulesService(
      prisma as any,
      { list: jest.fn().mockResolvedValue([]) } as any,
      staffExcuse as any,
      { log: jest.fn() } as any,
    );

    const user = { sub: 'u1', role: 'SUPER_ADMIN' } as any;
    await service.complete(1, user);

    expect(staffExcuse.excuseTeacherForMissedLesson).toHaveBeenCalled();
    expect(prisma.attendance_roll_records.upsert).not.toHaveBeenCalled();
  });
});

describe('StaffLessonReschedulesService.defaultSourceDate', () => {
  it('finds prior weekday occurrence', () => {
    const makeup = new Date('2026-09-06T00:00:00.000Z');
    const source = StaffLessonReschedulesService.defaultSourceDate(makeup, 1);
    expect(source.toISOString().slice(0, 10)).toBe('2026-08-31');
  });
});
