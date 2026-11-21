import { buildGroups, classifyGroup, HeadCopy } from './classify';
import { planCleanup } from './cleanup';
import { expectedDelta } from './reconcile';

let nextId = 100;
const head = (over: Partial<HeadCopy> = {}): HeadCopy => ({
  id: nextId++,
  student_id: 7000,
  fee_type_id: 1,
  fee_date: '2026-09-01',
  academic_year: '2026-2027',
  target_month: 9,
  month: 9,
  status: 'NOT_ISSUED',
  amount: 18995,
  amount_paid: 0,
  description_prefix: null,
  split_pair_id: null,
  installment_id: null,
  vouchers: [],
  allocations: [],
  ...over,
});
const voucher = (id: number, status: string) => ({
  id,
  status,
  voucher_number: null,
  issue_date: '2026-09-01',
});
const alloc = (deposit_id: number, amount: number, deposit_date: string) => ({
  id: deposit_id * 10,
  deposit_id,
  voucher_id: null,
  amount,
  type: 'FEE_HEAD',
  deposit_date,
});

beforeEach(() => {
  nextId = 100;
});

describe('legitimate groups', () => {
  it('a voucher split (paid part + balance) is one fee, not a duplicate', () => {
    const balance = head({
      status: 'ISSUED',
      amount: 8995,
      description_prefix: 'BALANCE PAYMENT OF',
      vouchers: [voucher(2, 'UNPAID')],
    });
    const partial = head({
      status: 'PAID',
      amount: 10000,
      amount_paid: 10000,
      description_prefix: 'PARTIAL PAYMENT OF',
      split_pair_id: balance.id,
      vouchers: [voucher(1, 'PAID')],
      allocations: [alloc(5, 10000, '2026-09-05')],
    });
    const g = classifyGroup('same_fee_date', [balance, partial]);
    expect(g.verdict).toBe('LEGIT');
    expect(g.reason).toContain('voucher split');
    expect(g.has_unpaid_copy).toBe(true); // the balance is still owed: that is what the ticket's 113 counted
    expect(g.billable_twice).toBe(false);
    expect(g.remove).toEqual([]);
  });

  it('a legacy split row without split_pair_id still pairs with the balance of its month', () => {
    const balance = head({
      status: 'PAID',
      amount: 5000,
      amount_paid: 5000,
      description_prefix: 'BALANCE PAYMENT OF',
      vouchers: [voucher(2, 'PAID')],
    });
    const partial = head({
      status: 'PAID',
      amount: 13995,
      amount_paid: 13995,
      description_prefix: 'PARTIAL PAYMENT OF',
      vouchers: [voucher(1, 'PAID')],
    });
    expect(classifyGroup('same_fee_date', [balance, partial]).verdict).toBe(
      'LEGIT',
    );
  });

  it('two part payments whose balance moved to a later fee date are one fee', () => {
    const partA = head({
      status: 'PAID',
      amount: 3875,
      amount_paid: 3875,
      description_prefix: 'PARTIAL PAYMENT OF',
      split_pair_id: 999,
    });
    const partB = head({
      status: 'PAID',
      amount: 10120,
      amount_paid: 10120,
      description_prefix: 'PARTIAL PAYMENT OF',
      split_pair_id: 999,
    });
    expect(classifyGroup('same_fee_date', [partA, partB]).verdict).toBe(
      'LEGIT',
    );
  });

  it('a whole year on one fee date repeats the fee date, never the month', () => {
    const year = [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7].map((m) =>
      head({ target_month: m, month: m, fee_date: '2026-08-01' }),
    );
    const g = classifyGroup('same_fee_date', year);
    expect(g.verdict).toBe('LEGIT');
    expect(g.reason).toContain('whole year');
    expect(g.billable_twice).toBe(false);
  });

  it('instalments of one fee spread over fee dates are a plan', () => {
    const rows = ['2026-09-01', '2026-10-01', '2026-11-01'].map((d) =>
      head({ fee_type_id: 16, fee_date: d, amount: 5000, installment_id: 3 }),
    );
    const groups = buildGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: 'same_month_other_dates',
      verdict: 'LEGIT',
      reason: 'instalment plan',
    });
  });
});

describe('duplicates', () => {
  it('two unbilled copies: keep the first, remove the other', () => {
    const a = head();
    const b = head();
    const g = classifyGroup('same_fee_date', [a, b]);
    expect(g.verdict).toBe('DUP_UNBILLED');
    expect(g.remove).toEqual([b.id]);
    expect(g.billable_twice).toBe(true);
    expect(g.action).toContain(`Remove the unbilled copy #${b.id}`);
  });

  it('one copy on a live voucher: keep it, remove the unbilled one, no voucher change', () => {
    const unbilled = head();
    const billed = head({
      status: 'ISSUED',
      vouchers: [voucher(40, 'OVERDUE')],
    });
    const g = classifyGroup('same_fee_date', [unbilled, billed]);
    expect(g.verdict).toBe('DUP_ONE_BILLED');
    expect(g.months[0].keep).toBe(billed.id);
    expect(g.remove).toEqual([unbilled.id]);
    expect(g.action).toContain('No voucher or deposit changes');
  });

  it('one copy paid: keep it, remove the unbilled one', () => {
    const paid = head({
      status: 'PAID',
      amount_paid: 18995,
      vouchers: [voucher(41, 'PAID')],
      allocations: [alloc(7, 18995, '2026-09-03')],
    });
    const unbilled = head();
    const g = classifyGroup('same_fee_date', [paid, unbilled]);
    expect(g.verdict).toBe('DUP_ONE_BILLED');
    expect(g.remove).toEqual([unbilled.id]);
  });

  it('both copies on the same live voucher: regenerate it, nothing deleted automatically', () => {
    const a = head({ status: 'ISSUED', vouchers: [voucher(50, 'UNPAID')] });
    const b = head({ status: 'ISSUED', vouchers: [voucher(50, 'UNPAID')] });
    const g = classifyGroup('same_fee_date', [a, b]);
    expect(g.verdict).toBe('DUP_NEEDS_REVERSAL');
    expect(g.remove).toEqual([]);
    expect(g.action).toContain('regenerate voucher 50 without this copy');
  });

  it("both copies paid: reverse the second copy's deposits newest first, nothing deleted automatically", () => {
    const a = head({
      status: 'PAID',
      amount_paid: 18995,
      vouchers: [voucher(60, 'PAID')],
      allocations: [alloc(1, 18995, '2026-09-02T10:00:00Z')],
    });
    const b = head({
      status: 'PAID',
      amount_paid: 18995,
      vouchers: [voucher(61, 'PAID')],
      allocations: [
        alloc(2, 8995, '2026-09-10T10:00:00Z'),
        alloc(3, 10000, '2026-09-20T10:00:00Z'),
      ],
    });
    const g = classifyGroup('same_fee_date', [a, b]);
    expect(g.verdict).toBe('DUP_NEEDS_REVERSAL');
    expect(g.remove).toEqual([]);
    expect(g.action).toContain('reverse deposit D3, then D2');
    expect(g.action).toContain('voucher 61 (PAID)');
  });
});

describe('unclear', () => {
  it('an unbilled copy on a VOID voucher is not free to delete (Rule A can bring the voucher back)', () => {
    const g = classifyGroup('same_fee_date', [
      head(),
      head({ vouchers: [voucher(70, 'VOID')] }),
    ]);
    expect(g.verdict).toBe('UNCLEAR');
    expect(g.remove).toEqual([]);
    expect(g.reason).toContain('VOID');
  });

  it('a waived copy is a write-off and is never removed by the cleanup', () => {
    const g = classifyGroup('same_fee_date', [
      head(),
      head({ status: 'WAIVED', vouchers: [voucher(71, 'WAIVED')] }),
    ]);
    expect(g.verdict).toBe('UNCLEAR');
  });

  it('copies with different amounts may not be the same fee', () => {
    const g = classifyGroup('same_fee_date', [head(), head({ amount: 1000 })]);
    expect(g.verdict).toBe('UNCLEAR');
    expect(g.reason).toContain('different amounts');
  });

  it('the same month on two fee dates always goes to a person, even when one copy is unbilled', () => {
    const paid = head({
      fee_date: '2026-07-01',
      target_month: 6,
      status: 'PAID',
      amount_paid: 18995,
      vouchers: [voucher(80, 'PAID')],
    });
    const future = head({ fee_date: '2027-06-01', target_month: 6 });
    const groups = buildGroups([paid, future]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: 'same_month_other_dates',
      verdict: 'UNCLEAR',
      remove: [],
    });
    expect(groups[0].action).toContain('wrong academic year or month');
    expect(planCleanup(groups).removals).toEqual([]);
  });
});

describe('planCleanup', () => {
  it('only plans removals for same-fee-date duplicates with at most one engaged copy', () => {
    const dupA = head({ student_id: 1 });
    const dupB = head({ student_id: 1 });
    const billedA = head({
      student_id: 2,
      status: 'ISSUED',
      vouchers: [voucher(90, 'UNPAID')],
    });
    const billedB = head({
      student_id: 2,
      status: 'ISSUED',
      vouchers: [voucher(90, 'UNPAID')],
    });
    const plan = planCleanup(buildGroups([dupA, dupB, billedA, billedB]));
    expect(plan.removals.map((r) => r.student_fee_id)).toEqual([dupB.id]);
    expect(plan.removals[0]).toMatchObject({ keep_id: dupA.id, amount: 18995 });
    expect(plan.manual.map((g) => g.student_id)).toEqual([2]);
  });
});

describe('expectedDelta', () => {
  const before = {
    count: 10,
    billed: 500,
    to_be_billed: 300,
    waived: 0,
    amount: 800,
    amount_paid: 200,
    outstanding: 600,
  };
  it('accepts a removal that only lowers amount, to-be-billed and outstanding', () => {
    expect(
      expectedDelta(
        before,
        {
          ...before,
          count: 9,
          to_be_billed: 250,
          amount: 750,
          outstanding: 550,
        },
        50,
        1,
      ),
    ).toEqual([]);
  });
  it('flags any other movement', () => {
    expect(
      expectedDelta(
        before,
        { ...before, count: 9, billed: 450, amount: 750, outstanding: 550 },
        50,
        1,
      ),
    ).toEqual([
      'billed: expected 500, got 450',
      'to_be_billed: expected 250, got 300',
    ]);
  });
});
