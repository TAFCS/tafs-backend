import { BadRequestException } from '@nestjs/common';
jest.mock('uuid', () => ({ v4: () => 'uuid' }));
import { EmployeesService } from './employees.service';

// TAFSD-377: working days and per-weekday timings sent with a new employee.
const svc = Object.create(EmployeesService.prototype) as any;

describe('create: work_schedule and day_timings (TAFSD-377)', () => {
  it('sorts the working-day pattern and defaults is_working to true', () => {
    expect(svc.normaliseWorkSchedule([{ day_of_week: 5, is_working: false }, { day_of_week: 1 }])).toEqual([
      { day_of_week: 1, is_working: true },
      { day_of_week: 5, is_working: false },
    ]);
  });

  it('refuses a day outside 0–6, a repeated day, or no working day at all', () => {
    expect(() => svc.normaliseWorkSchedule([{ day_of_week: 7 }])).toThrow(BadRequestException);
    expect(() => svc.normaliseWorkSchedule([{ day_of_week: 1 }, { day_of_week: 1 }])).toThrow('listed twice');
    expect(() => svc.normaliseWorkSchedule([{ day_of_week: 1, is_working: false }])).toThrow('at least one working day');
  });

  it('keeps only days with their own times, and refuses a day that ends before it starts', () => {
    expect(svc.normaliseDayTimings([{ day_of_week: 5, reporting_time: '07:30', leaving_time: '12:00' }, { day_of_week: 1 }])).toEqual([
      { day_of_week: 5, reporting_time: '07:30', leaving_time: '12:00' },
    ]);
    expect(() => svc.normaliseDayTimings([{ day_of_week: 5, reporting_time: '12:00', leaving_time: '07:30' }])).toThrow('leaving time');
  });
});
