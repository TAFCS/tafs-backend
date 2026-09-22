import { AttendancePolicyResolverService } from './attendance-policy-resolver.service';

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
/** 2026-09-21 is a Monday, so +n lands on the weekday you'd expect. */
const monday = new Date(Date.UTC(2026, 8, 21));
const dayAfterMonday = (n: number) => new Date(Date.UTC(2026, 8, 21 + n));

const BASE = {
  class_id: 6,
  campus_id: 1,
  expected_check_in: time('08:00'),
  end_time: time('13:30'),
  intermediate_time: time('12:30'),
  late_grace_minutes: 10,
  effective_from: new Date(Date.UTC(2026, 8, 1)),
};

const FRIDAY = {
  day_of_week: 5,
  expected_check_in: time('08:00'),
  end_time: time('12:30'),
  intermediate_time: time('11:30'),
};

const resolver = () => new AttendancePolicyResolverService({} as never, {} as never);

const resolve = (date: Date, schedules: unknown[]) =>
  resolver().resolveStudentCheckInPolicyFromCache(6, 1, date, schedules as never, []);

describe('weekday overrides', () => {
  it('uses the base schedule on an ordinary day', () => {
    const r = resolve(monday, [{ ...BASE, class_check_in_schedule_days: [FRIDAY] }]);
    expect(r.endTime).toEqual(time('13:30'));
    expect(r.intermediateTime).toEqual(time('12:30'));
  });

  it('swaps in the Friday override on a Friday', () => {
    const r = resolve(dayAfterMonday(4), [{ ...BASE, class_check_in_schedule_days: [FRIDAY] }]);
    expect(r.endTime).toEqual(time('12:30'));
    expect(r.intermediateTime).toEqual(time('11:30'));
    // Grace is not per-day — it still comes from the schedule.
    expect(r.graceMinutes).toBe(10);
  });

  it.each([
    ['Tuesday', 1],
    ['Wednesday', 2],
    ['Thursday', 3],
    ['Saturday', 5],
    ['Sunday', 6],
  ])('leaves %s on the base schedule', (_label, offset) => {
    const r = resolve(dayAfterMonday(offset), [{ ...BASE, class_check_in_schedule_days: [FRIDAY] }]);
    expect(r.intermediateTime).toEqual(time('12:30'));
  });

  it('falls back to the base when the pairing has no overrides at all', () => {
    const r = resolve(dayAfterMonday(4), [{ ...BASE, class_check_in_schedule_days: [] }]);
    expect(r.endTime).toEqual(time('13:30'));
  });

  it('tolerates a schedule loaded without its day rows', () => {
    // The relation is optional on the type; a loader that forgets the include
    // must degrade to the base rather than throwing.
    const r = resolve(dayAfterMonday(4), [BASE]);
    expect(r.endTime).toEqual(time('13:30'));
  });

  it('replaces wholesale — a day row with no end time does not inherit one', () => {
    const r = resolve(dayAfterMonday(4), [
      { ...BASE, class_check_in_schedule_days: [{ ...FRIDAY, end_time: null, intermediate_time: null }] },
    ]);
    expect(r.endTime).toBeNull();
    expect(r.intermediateTime).toBeNull();
  });

  it('still picks the newest effective schedule before applying the override', () => {
    const older = { ...BASE, effective_from: new Date(Date.UTC(2026, 7, 1)), class_check_in_schedule_days: [] };
    const newer = {
      ...BASE,
      effective_from: new Date(Date.UTC(2026, 8, 15)),
      class_check_in_schedule_days: [FRIDAY],
    };
    const r = resolve(dayAfterMonday(4), [older, newer]);
    expect(r.endTime).toEqual(time('12:30'));
  });

  it('ignores a campus that is not the student\'s, override and all', () => {
    const other = { ...BASE, campus_id: 2, class_check_in_schedule_days: [FRIDAY] };
    const r = resolver().resolveStudentCheckInPolicyFromCache(6, 1, dayAfterMonday(4), [other] as never, []);
    expect(r.expectedCheckIn).toBeNull();
  });
});
