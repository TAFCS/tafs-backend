import { EmployeeTimingsService, pktDayStart, timingsDelta } from './employee-timings.service';

// TAFSD-369: timing changes take effect from a chosen date, separate from when they're saved.

const T = (over: Record<string, unknown> = {}) => ({
  check_in_source: 'FIXED', reporting_time: '07:30', leaving_time: '14:20', late_relaxation_minutes: 5,
  days_per_week: 5, working_days: null, day_timings: [], ...over,
});
const dims = { employee_id: 91, campus_id: 2, segment_id: null, department_id: 1, staff_category_id: 1, reporting_manager_id: null, job_title: 'T', employment_type: null, employment_status: 'ACTIVE', monthly_pay: '40000', payroll_enabled: true, class_sections: [] };

function build(periods: any[]) {
  const created: any[] = [];
  const updated: any[] = [];
  const tx = {
    employee_progression_periods: {
      findMany: jest.fn(async () => periods),
      update: jest.fn(async (a: any) => updated.push(a)),
      create: jest.fn(async (a: any) => created.push(a.data)),
    },
    employee_profiles: { update: jest.fn(async () => ({})) },
    employee_work_schedules: { deleteMany: jest.fn(), createMany: jest.fn() },
    employee_day_timings: { deleteMany: jest.fn(), createMany: jest.fn() },
  };
  const svc = new EmployeeTimingsService({} as any, { log: jest.fn() } as any);
  return { svc, tx, created, updated };
}

describe('EmployeeTimingsService.applyInTx', () => {
  const history = () => [
    { id: 1, ...dims, valid_from: new Date('2026-07-26T00:00:00Z'), valid_to: new Date('2026-10-13T02:19:25Z'), change_type: 'SALARY_INCREMENT', timings: T() },
    { id: 2, ...dims, valid_from: new Date('2026-10-13T02:19:25Z'), valid_to: null, change_type: 'REASSIGNED', timings: T() },
  ];

  it('back-dated: splits the period covering the date at PKT midnight and carries the new timings forward', async () => {
    const { svc, tx, created, updated } = build(history());
    const next = T({ leaving_time: '16:30' });
    const r = await svc.applyInTx(tx as any, 91, next as any, '2026-10-10', 'aawaiz', new Date('2026-10-17T01:40:00Z'), null);
    expect(r.status).toBe('APPLIED');
    expect(updated[0]).toEqual({ where: { id: 1 }, data: { valid_to: pktDayStart('2026-10-10') } });
    expect(created[0]).toMatchObject({
      change_type: 'TIMING_CHANGED', valid_from: pktDayStart('2026-10-10'), valid_to: new Date('2026-10-13T02:19:25Z'),
      timings: next, recorded_at: new Date('2026-10-17T01:40:00Z'), changed_by: 'aawaiz', notes: 'Out 14:20 → 16:30',
    });
    expect(updated.find((u) => u.where.id === 2)?.data.timings).toEqual(next);
    expect(tx.employee_profiles.update).toHaveBeenCalled();
    expect(pktDayStart('2026-10-10').toISOString()).toBe('2026-10-09T19:00:00.000Z');
  });

  it('refuses a back-date that would overwrite a later timing change', async () => {
    const h = history();
    h[1].timings = T({ reporting_time: '07:00' });
    const { svc, tx } = build(h);
    await expect(svc.applyInTx(tx as any, 91, T({ leaving_time: '16:30' }) as any, '2026-10-10', 'x', new Date(), null))
      .rejects.toThrow(/changed again with effect from 2026-10-13/);
  });

  it('a second change on the same effective day replaces the first', async () => {
    const h = history();
    h.push({ id: 3, ...dims, valid_from: pktDayStart('2026-10-17'), valid_to: null, change_type: 'TIMING_CHANGED', timings: T({ leaving_time: '16:00' }) });
    h[1].valid_to = pktDayStart('2026-10-17');
    h[1].timings = T();
    const { svc, tx, created, updated } = build(h);
    await svc.applyInTx(tx as any, 91, T({ leaving_time: '16:30' }) as any, '2026-10-17', 'x', new Date(), null);
    expect(created).toHaveLength(0);
    expect(updated[0]).toMatchObject({ where: { id: 3 }, data: { timings: T({ leaving_time: '16:30' }), change_type: 'TIMING_CHANGED' } });
  });

  it('refuses a date before the employee\'s history starts', async () => {
    const { svc, tx } = build(history());
    await expect(svc.applyInTx(tx as any, 91, T({ leaving_time: '16:30' }) as any, '2026-01-01', 'x', new Date(), null))
      .rejects.toThrow(/before this employee's history starts/);
  });
});

describe('EmployeeTimingsService.mergeSnapshot', () => {
  const svc = new EmployeeTimingsService({} as any, {} as any);
  it('keeps omitted fields and folds a standard working-day pattern into days_per_week', () => {
    const next = svc.mergeSnapshot(T() as any, { working_days: [1, 2, 3, 4, 5, 6] });
    expect(next).toMatchObject({ working_days: null, days_per_week: 6, reporting_time: '07:30' });
    expect(svc.mergeSnapshot(T() as any, { working_days: [1, 2, 3, 4, 6] })).toMatchObject({ working_days: [1, 2, 3, 4, 6], days_per_week: 5 });
  });
  it('validates times', () => {
    expect(() => svc.mergeSnapshot(T() as any, { leaving_time: '07:00' })).toThrow(/after reporting/);
    expect(() => svc.mergeSnapshot(T() as any, { day_timings: [{ day_of_week: 5, leaving_time: '07:00' }] })).toThrow(/Fri/);
  });
});

describe('EmployeeTimingsService.changeTimings (future date)', () => {
  it('schedules instead of applying', async () => {
    const upsert = jest.fn(async () => ({}));
    const prisma = {
      employee_profiles: {
        findUnique: jest.fn(async (a: any) =>
          a.include
            ? { check_in_source: 'FIXED', reporting_time: new Date(Date.UTC(1970, 0, 1, 7, 30)), leaving_time: new Date(Date.UTC(1970, 0, 1, 14, 20)), late_relaxation_minutes: 5, days_per_week: 5, employee_work_schedules: [], employee_day_timings: [] }
            : { full_name: 'X', campus_id: 2 },
        ),
      },
      employee_scheduled_timing_changes: { upsert },
      $transaction: jest.fn(),
    };
    const svc = new EmployeeTimingsService(prisma as any, { log: jest.fn() } as any);
    const r = await svc.changeTimings(91, { effective_from: '2099-01-02', leaving_time: '12:00' }, 'aawaiz');
    expect(r.status).toBe('SCHEDULED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect((upsert.mock.calls[0] as any)[0].create.timings).toMatchObject({ leaving_time: '12:00' });
  });
});

// TAFSD-439: a back-dated change can override a later timings change.
describe('EmployeeTimingsService override of later changes', () => {
  const history = () => [
    { id: 1, ...dims, valid_from: new Date('2026-07-26T00:00:00Z'), valid_to: new Date('2026-10-13T02:19:25Z'), change_type: 'SALARY_INCREMENT', timings: T() },
    // A later change moved reporting to 07:00 from 13 Oct.
    { id: 2, ...dims, valid_from: new Date('2026-10-13T02:19:25Z'), valid_to: null, change_type: 'TIMING_CHANGED', timings: T({ reporting_time: '07:00' }) },
  ];

  it('timingsDelta keeps only what changed, a single weekday as a patch', () => {
    const cur = T({ day_timings: [{ day_of_week: 1, reporting_time: '08:00', leaving_time: null }] }) as any;
    const next = T({ day_timings: [
      { day_of_week: 1, reporting_time: '08:00', leaving_time: null },
      { day_of_week: 5, reporting_time: '07:30', leaving_time: '12:45' },
    ] }) as any;
    expect(timingsDelta(cur, next)).toEqual({ day_timing_patch: [{ day_of_week: 5, reporting_time: '07:30', leaving_time: '12:45' }] });
    expect(timingsDelta(T() as any, T({ leaving_time: '16:00' }) as any)).toEqual({ leaving_time: '16:00' });
  });

  it('applies from its date and carries only the changed day through the later period', async () => {
    const { svc, tx, created, updated } = build(history());
    const friday = { day_timing_patch: [{ day_of_week: 5, reporting_time: '07:30', leaving_time: '12:45' }] };
    const latest = T({ reporting_time: '07:00', day_timings: [{ day_of_week: 5, reporting_time: '07:30', leaving_time: '12:45' }] });
    const r = await svc.applyInTx(tx as any, 91, latest as any, '2026-09-26', 'x', new Date(), null, friday);
    expect(r.status).toBe('APPLIED');
    // Split at 26 Sep: 07:30 reporting kept, Friday added.
    expect(created[0]).toMatchObject({ valid_from: pktDayStart('2026-09-26'), timings: { reporting_time: '07:30', day_timings: [{ day_of_week: 5, reporting_time: '07:30', leaving_time: '12:45' }] } });
    // The 13 Oct change keeps its 07:00 reporting and gains the Friday hours.
    expect(updated.find((u) => u.where.id === 2)?.data.timings).toMatchObject({ reporting_time: '07:00', day_timings: [{ day_of_week: 5, reporting_time: '07:30', leaving_time: '12:45' }] });
    expect(tx.employee_profiles.update).toHaveBeenCalled();
  });

  it('without override it is still refused, and the message says it can be overridden', async () => {
    const { svc, tx } = build(history());
    await expect(svc.applyInTx(tx as any, 91, T({ leaving_time: '16:30' }) as any, '2026-10-10', 'x', new Date(), null))
      .rejects.toThrow(/apply it anyway/);
  });

  it('a patch with both times null puts that weekday back to normal', () => {
    const svc = new EmployeeTimingsService({} as any, {} as any);
    const t = T({ day_timings: [{ day_of_week: 5, reporting_time: '07:30', leaving_time: '12:45' }] }) as any;
    expect(svc.mergeSnapshot(t, { day_timing_patch: [{ day_of_week: 5, reporting_time: null, leaving_time: null }] }).day_timings).toEqual([]);
  });
});
