import { Prisma } from '@prisma/client';
import { buildCreateSchedule, restoreScheduleBeforeCollection } from './installment-schedule.util';

const d = (n: number) => new Prisma.Decimal(n);

describe('buildCreateSchedule', () => {
  it('splits equally when no months were picked', () => {
    expect(buildCreateSchedule(d(10000), 3, undefined)).toEqual([3333.33, 3333.33, 3333.34]);
  });

  it('keeps an explicit schedule with skipped (0) months', () => {
    expect(buildCreateSchedule(d(10000), 4, [5000, 0, 0, 5000])).toEqual([5000, 0, 0, 5000]);
  });

  it('rejects an explicit schedule that does not add up', () => {
    expect(() => buildCreateSchedule(d(10000), 2, [5000, 4000])).toThrow(/add up/);
  });

  it('rejects a schedule that opens on a skipped month', () => {
    expect(() => buildCreateSchedule(d(10000), 2, [0, 10000])).toThrow(/first month/);
  });

  it('rejects a count that disagrees with the amounts', () => {
    expect(() => buildCreateSchedule(d(10000), 3, [5000, 5000])).toThrow(/installment_count/);
  });
});

describe('restoreScheduleBeforeCollection (TAFSD-394)', () => {
  const D = (n: number) => new Prisma.Decimal(n);

  it('puts the collected slot back in front of the remaining schedule', () => {
    // 3000 over [1000, 1000, 1000]; one cycle collected 1000 -> [1000, 1000] now.
    expect(restoreScheduleBeforeCollection([1000, 1000], D(1000), D(3000))).toEqual([1000, 1000, 1000]);
  });

  it('folds a shortfall carry into the first slot so the next cycle owes the same', () => {
    // Due 1000, only 600 collected; schedule sliced to [1000], carry 400 (remaining 2400).
    expect(restoreScheduleBeforeCollection([1000], D(1000), D(3000))).toEqual([1000, 2000]);
  });

  it('restores a plan the collection completed', () => {
    expect(restoreScheduleBeforeCollection([], D(500), D(500))).toEqual([500]);
  });

  it('keeps the total equal to what was remaining before', () => {
    const out = restoreScheduleBeforeCollection([2400], D(1000), D(3000));
    expect(out.reduce((a, b) => a + b, 0)).toBe(3000);
    expect(out[0]).toBe(1000);
  });
});
