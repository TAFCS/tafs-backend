import { Prisma } from '@prisma/client';
import { buildCreateSchedule } from './installment-schedule.util';

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
