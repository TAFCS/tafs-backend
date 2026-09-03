import { Test, TestingModule } from '@nestjs/testing';
import { CalendarDayResolverService } from './calendar-day-resolver.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { CheckInSource } from '@prisma/client';

describe('CalendarDayResolverService', () => {
  let service: CalendarDayResolverService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      employee_profiles: {
        findUnique: jest.fn(),
      },
      academic_calendar_days: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      timetable_slots: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
      staff_lesson_reschedules: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      employee_shift_overrides: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      teacher_saturday_schedules: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CalendarDayResolverService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CalendarDayResolverService>(CalendarDayResolverService);
  });

  it('should resolve isWorkingDay = true on days with active timetable slots for TIMETABLE staff', async () => {
    prisma.employee_profiles.findUnique.mockResolvedValue({
      department_id: 1,
      staff_category_id: 1,
      staff_categories: { code: 'TEACHER' },
      days_per_week: 5,
      employee_work_schedules: [],
      check_in_source: CheckInSource.TIMETABLE,
    });

    // Monday (1): count returns 2 slots
    prisma.timetable_slots.count.mockResolvedValue(2);

    const monDate = new Date('2026-08-31T00:00:00Z'); // Monday (day_of_week = 1)
    const monResolved = await service.resolveStaffDay(10, 1, monDate);

    expect(monResolved.isWorkingDay).toBe(true);
  });

  it('should resolve isWorkingDay = false on days with 0 timetable slots for TIMETABLE staff', async () => {
    prisma.employee_profiles.findUnique.mockResolvedValue({
      department_id: 1,
      staff_category_id: 1,
      staff_categories: { code: 'TEACHER' },
      days_per_week: 5,
      employee_work_schedules: [],
      check_in_source: CheckInSource.TIMETABLE,
    });

    // Tuesday (2): 0 timetable slots
    prisma.timetable_slots.count.mockResolvedValue(0);

    const tueDate = new Date('2026-09-01T00:00:00Z'); // Tuesday (day_of_week = 2)
    const tueResolved = await service.resolveStaffDay(10, 1, tueDate);

    expect(tueResolved.isWorkingDay).toBe(false);
    expect(tueResolved.description).toContain('No timetable slots');
  });

  it('should resolve isWorkingDay = true for FIXED staff on default Mon-Fri weekdays', async () => {
    prisma.employee_profiles.findUnique.mockResolvedValue({
      department_id: 1,
      staff_category_id: 2,
      staff_categories: { code: 'ADMIN' },
      days_per_week: 5,
      employee_work_schedules: [],
      check_in_source: CheckInSource.FIXED,
    });

    const tueDate = new Date('2026-09-01T00:00:00Z'); // Tuesday
    const tueResolved = await service.resolveStaffDay(10, 1, tueDate);

    expect(tueResolved.isWorkingDay).toBe(true);
  });
});
