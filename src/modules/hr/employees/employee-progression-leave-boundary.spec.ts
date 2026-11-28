import { EmployeeProgressionService } from './employee-progression.service';

/**
 * TAFSD-602: on rejoin, before date_of_leaving is cleared, the boundary
 * between the last ACTIVE row and the leave is moved to UTC midnight of the
 * day after the leaving date, so that cycle keeps paying the last day.
 */
type Row = { id: number; employment_status: string; valid_from: Date; valid_to: Date | null };

function fakeTx(rows: Row[]) {
  const store = rows.map((r) => ({ ...r }));
  const tx = {
    employee_progression_periods: {
      findMany: jest.fn(async () =>
        [...store].sort((a, b) => a.valid_from.getTime() - b.valid_from.getTime() || a.id - b.id),
      ),
      update: jest.fn(async ({ where, data }: { where: { id: number }; data: Partial<Row> }) => {
        const row = store.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
  };
  return { tx: tx as any, store };
}

const at = (iso: string) => new Date(iso);
const svc = new EmployeeProgressionService();

describe('EmployeeProgressionService.alignLeaveBoundary (TAFSD-602)', () => {
  afterEach(() => jest.useRealTimers());

  it('moves a same-day click boundary forward to midnight UTC after the leaving date', async () => {
    jest.useFakeTimers().setSystemTime(at('2026-12-10T06:00:00.000Z'));
    const { tx, store } = fakeTx([
      { id: 1, employment_status: 'ACTIVE', valid_from: at('2024-11-11T00:00:00.000Z'), valid_to: at('2026-11-25T18:59:00.000Z') },
      { id: 2, employment_status: 'LEFT', valid_from: at('2026-11-25T18:59:00.000Z'), valid_to: null },
    ]);
    await svc.alignLeaveBoundary(tx, 7, at('2026-11-25T00:00:00.000Z'));
    expect(store[0].valid_to).toEqual(at('2026-11-26T00:00:00.000Z'));
    expect(store[1].valid_from).toEqual(at('2026-11-26T00:00:00.000Z'));
  });

  it('moves a past-dated leave boundary back to the day after the leaving date', async () => {
    jest.useFakeTimers().setSystemTime(at('2026-12-10T06:00:00.000Z'));
    const { tx, store } = fakeTx([
      { id: 1, employment_status: 'ACTIVE', valid_from: at('2024-11-11T00:00:00.000Z'), valid_to: at('2026-11-20T06:00:00.000Z') },
      { id: 2, employment_status: 'LEFT', valid_from: at('2026-11-20T06:00:00.000Z'), valid_to: null },
    ]);
    await svc.alignLeaveBoundary(tx, 7, at('2026-11-12T00:00:00.000Z'));
    expect(store[0].valid_to).toEqual(at('2026-11-13T00:00:00.000Z'));
    expect(store[1].valid_from).toEqual(at('2026-11-13T00:00:00.000Z'));
  });

  it('never moves past now: a future leave revoked early (or a same-evening rejoin) leaves no gap', async () => {
    jest.useFakeTimers().setSystemTime(at('2026-11-25T18:58:00.000Z'));
    const { tx, store } = fakeTx([
      { id: 1, employment_status: 'ACTIVE', valid_from: at('2024-11-11T00:00:00.000Z'), valid_to: at('2026-11-25T18:55:00.000Z') },
      { id: 2, employment_status: 'LEFT', valid_from: at('2026-11-25T18:55:00.000Z'), valid_to: null },
    ]);
    await svc.alignLeaveBoundary(tx, 7, at('2026-11-25T00:00:00.000Z'));
    expect(store[0].valid_to).toEqual(at('2026-11-25T18:58:00.000Z'));
    expect(store[1].valid_from).toEqual(at('2026-11-25T18:58:00.000Z'));
  });

  it('only touches the current leave, not an earlier leave before a rejoin', async () => {
    jest.useFakeTimers().setSystemTime(at('2026-12-10T06:00:00.000Z'));
    const { tx, store } = fakeTx([
      { id: 1, employment_status: 'ACTIVE', valid_from: at('2024-01-01T00:00:00.000Z'), valid_to: at('2026-09-02T00:00:00.000Z') },
      { id: 2, employment_status: 'LEFT', valid_from: at('2026-09-02T00:00:00.000Z'), valid_to: at('2026-09-15T00:00:00.000Z') },
      { id: 3, employment_status: 'ACTIVE', valid_from: at('2026-09-15T00:00:00.000Z'), valid_to: at('2026-10-10T08:00:00.000Z') },
      { id: 4, employment_status: 'LEFT', valid_from: at('2026-10-10T08:00:00.000Z'), valid_to: null },
    ]);
    await svc.alignLeaveBoundary(tx, 7, at('2026-10-10T00:00:00.000Z'));
    expect(store.map((r) => [r.id, r.valid_from.toISOString(), r.valid_to?.toISOString() ?? null])).toEqual([
      [1, '2024-01-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'],
      [2, '2026-09-02T00:00:00.000Z', '2026-09-15T00:00:00.000Z'],
      [3, '2026-09-15T00:00:00.000Z', '2026-10-11T00:00:00.000Z'],
      [4, '2026-10-11T00:00:00.000Z', null],
    ]);
  });

  it('is a no-op when the latest row is ACTIVE or the rows do not meet', async () => {
    const { tx } = fakeTx([
      { id: 1, employment_status: 'ACTIVE', valid_from: at('2024-01-01T00:00:00.000Z'), valid_to: null },
    ]);
    await svc.alignLeaveBoundary(tx, 7, at('2026-10-10T00:00:00.000Z'));
    expect(tx.employee_progression_periods.update).not.toHaveBeenCalled();

    const gap = fakeTx([
      { id: 1, employment_status: 'ACTIVE', valid_from: at('2024-01-01T00:00:00.000Z'), valid_to: at('2026-10-01T00:00:00.000Z') },
      { id: 2, employment_status: 'LEFT', valid_from: at('2026-10-05T00:00:00.000Z'), valid_to: null },
    ]);
    await svc.alignLeaveBoundary(gap.tx, 7, at('2026-10-10T00:00:00.000Z'));
    expect(gap.tx.employee_progression_periods.update).not.toHaveBeenCalled();
  });
});
