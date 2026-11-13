import { PayrollService } from './payroll.service';
import { STAFF_VISIBLE_RUN, isStaffVisibleRun } from './staff-visibility.util';

// TAFSD-478: a run reaches the staff app only once it's released, not when it's finalized.

const user = { sub: 'u1', role: 'SUPER_ADMIN', username: 'aawaiz' } as any;
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

function build(run: any) {
  const svc = Object.create(PayrollService.prototype) as any;
  const updates: any[] = [];
  const lineFind = jest.fn(async () => [] as any[]);
  svc.prisma = {
    payroll_runs: {
      findUnique: jest.fn(async () => run),
      update: jest.fn(async (args: any) => updates.push(args)),
    },
    payroll_run_lines: {
      findMany: lineFind,
      findUnique: jest.fn(async () => null),
    },
    employee_profiles: { findUnique: jest.fn(async () => ({ id: 7 })) },
  };
  svc.canSeeRun = () => true;
  svc.auditLogs = { log: jest.fn() };
  svc.logger = { error: jest.fn() };
  svc.employeeNoticeBoard = {
    createPayrollNotice: jest.fn(async () => undefined),
  };
  svc.getRun = jest.fn(async () => ({ id: run?.id }));
  return { svc, updates, lineFind };
}

const baseRun = (extra: any = {}) => ({
  id: 79,
  campus_id: 2,
  is_test: false,
  released_to_staff_at: null,
  period_start: D('2026-09-26'),
  period_end: D('2026-10-25'),
  payroll_run_lines: [
    {
      employee_id: 1,
      finalized_at: D('2026-11-01'),
      employee_profiles: { user_id: 'a' },
    },
    { employee_id: 2, finalized_at: null, employee_profiles: { user_id: 'b' } },
  ],
  ...extra,
});

describe('TAFSD-478: release to staff', () => {
  it('releases a run and notifies only employees with a finalized line', async () => {
    const { svc, updates } = build(baseRun());
    await svc.releaseRun(79, user);
    await new Promise((r) => setImmediate(r)); // the notice text is read from the templates first
    expect(updates[0].data.released_to_staff_at).toBeInstanceOf(Date);
    expect(svc.employeeNoticeBoard.createPayrollNotice).toHaveBeenCalledTimes(
      1,
    );
    expect(svc.employeeNoticeBoard.createPayrollNotice.mock.calls[0][1]).toBe(
      'a',
    );
  });

  it('refuses test runs, already released runs and runs with nothing finalized', async () => {
    await expect(
      build(baseRun({ is_test: true })).svc.releaseRun(79, user),
    ).rejects.toThrow(/never shown/);
    await expect(
      build(baseRun({ released_to_staff_at: D('2026-11-02') })).svc.releaseRun(
        79,
        user,
      ),
    ).rejects.toThrow(/already released/);
    const none = baseRun({
      payroll_run_lines: [
        {
          employee_id: 2,
          finalized_at: null,
          employee_profiles: { user_id: 'b' },
        },
      ],
    });
    await expect(build(none).svc.releaseRun(79, user)).rejects.toThrow(
      /Finalize at least one/,
    );
  });

  it('hides a released run again', async () => {
    const { svc, updates } = build(
      baseRun({ released_to_staff_at: D('2026-11-02') }),
    );
    await svc.unreleaseRun(79, user);
    expect(updates[0].data).toEqual({
      released_to_staff_at: null,
      released_by: null,
    });
  });

  it('staff only ever see released, non-test runs', async () => {
    const { svc, lineFind } = build(baseRun());
    await svc.listMyPayrollLines('a');
    expect((lineFind.mock.calls[0] as any)[0].where.payroll_runs).toEqual(
      STAFF_VISIBLE_RUN,
    );
    expect(
      isStaffVisibleRun({ is_test: false, released_to_staff_at: null }),
    ).toBe(false);
    expect(
      isStaffVisibleRun({
        is_test: true,
        released_to_staff_at: D('2026-11-02'),
      }),
    ).toBe(false);
    expect(
      isStaffVisibleRun({
        is_test: false,
        released_to_staff_at: D('2026-11-02'),
      }),
    ).toBe(true);
  });
});
