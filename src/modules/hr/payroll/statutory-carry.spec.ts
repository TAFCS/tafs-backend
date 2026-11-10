import { Prisma } from '@prisma/client';
import { PayrollService, capStatutory } from './payroll.service';

// TAFSD-500 (Mirza, item 48): EOBI and income tax never take net pay below 0.
// They're taken from what's left after attendance cuts, EOBI first; the rest
// carries to the next cycle. A cycle that earns nothing records no employer
// EOBI / SESSI either.

const D = (n: number) => new Prisma.Decimal(n);
const due = {
  eobi: 370,
  income_tax: 200,
  eobi_employer: 1850,
  sessi_employer: 1110,
};
const none = { eobi: D(0), income_tax: D(0) };

describe('capStatutory', () => {
  it('a normal month takes everything and carries nothing', () => {
    const c = capStatutory(D(30000), D(2000), due, none);
    expect(c).toMatchObject({
      eobi_deduction: D(370),
      income_tax_deduction: D(200),
      eobi_carried_out: D(0),
      income_tax_carried_out: D(0),
    });
    expect(Number(c.eobi_employer_cost)).toBe(1850);
  });

  it('a fully cut month takes nothing, carries it all, and records no employer cost', () => {
    const c = capStatutory(D(30000), D(30000), due, none);
    expect(Number(c.eobi_deduction)).toBe(0);
    expect(Number(c.income_tax_deduction)).toBe(0);
    expect(Number(c.eobi_carried_out)).toBe(370);
    expect(Number(c.income_tax_carried_out)).toBe(200);
    expect(Number(c.eobi_employer_cost)).toBe(0);
    expect(Number(c.sessi_employer_cost)).toBe(0);
  });

  it('a little pay left: EOBI first, up to what is left; the rest carries', () => {
    const c = capStatutory(D(30000), D(29800), due, none); // 200 left
    expect(Number(c.eobi_deduction)).toBe(200);
    expect(Number(c.eobi_carried_out)).toBe(170);
    expect(Number(c.income_tax_deduction)).toBe(0);
    expect(Number(c.income_tax_carried_out)).toBe(200);
    // Something was earned, so the employer's share is recorded.
    expect(Number(c.eobi_employer_cost)).toBe(1850);
  });

  it('next month takes its own EOBI plus what was carried', () => {
    const c = capStatutory(D(30000), D(0), due, {
      eobi: D(370),
      income_tax: D(200),
    });
    expect(Number(c.eobi_deduction)).toBe(740);
    expect(Number(c.income_tax_deduction)).toBe(400);
    expect(Number(c.eobi_carried_out)).toBe(0);
  });

  it('carries keep adding up across consecutive empty months', () => {
    const c = capStatutory(D(30000), D(30000), due, {
      eobi: D(370),
      income_tax: D(200),
    });
    expect(Number(c.eobi_carried_out)).toBe(740);
    expect(Number(c.income_tax_carried_out)).toBe(400);
  });
});

describe('applyStatutoryCapToLine', () => {
  const line = (over: object = {}) => ({
    id: 1,
    finalized_at: null,
    monthly_pay: D(30000),
    absence_deduction: D(20000),
    half_day_deduction: D(0),
    late_deduction: D(0),
    early_leave_deduction: D(0),
    break_deduction: D(0),
    after_leaving_deduction: D(0),
    sandwich_deduction: D(10000),
    consecutive_late_deduction: D(0),
    eobi_carried_in: D(0),
    income_tax_carried_in: D(0),
    statutory_due: due,
    ...over,
  });
  const run = async (row: object | null) => {
    const svc = Object.create(PayrollService.prototype) as any;
    const tx = {
      payroll_run_lines: {
        findFirst: jest.fn(async () => row),
        update: jest.fn(async () => ({})),
      },
    };
    await svc.applyStatutoryCapToLine(1, 9, tx);
    return tx.payroll_run_lines.update.mock.calls[0] as any;
  };

  it('once the sandwiches are applied and nothing is left, EOBI and tax carry over', async () => {
    const call = await run(line());
    expect(Number(call[0].data.eobi_deduction)).toBe(0);
    expect(Number(call[0].data.eobi_carried_out)).toBe(370);
    expect(Number(call[0].data.income_tax_carried_out)).toBe(200);
  });

  it('leaves finalized lines and lines from before the cap alone', async () => {
    expect(await run(line({ finalized_at: new Date() }))).toBeUndefined();
    expect(await run(line({ statutory_due: null }))).toBeUndefined();
  });
});
