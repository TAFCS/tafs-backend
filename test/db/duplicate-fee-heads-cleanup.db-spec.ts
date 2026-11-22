/**
 * TAFSD-546: the duplicate fee head audit and cleanup, end to end against a
 * throwaway Postgres.
 *
 * Seeds the shapes production actually has (a voucher split, a whole year on
 * one fee date) beside real duplicates in every class, then checks that the
 * audit classifies them, that a dry run writes nothing, and that applying
 * deletes only the unbilled extra copies, re-checks under lock, logs each
 * delete, and leaves the Fee Heads report reconciled with only amount /
 * to-be-billed / outstanding lowered by the removed sum.
 */
import { Prisma } from '@prisma/client';
import type { INestApplication } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp } from './helpers/app';
import {
  FEE,
  STUDENT,
  YEAR,
  issueVoucher,
  seedSchool,
} from './helpers/fixtures';
import { loadAudit } from '../../src/modules/student-fees/duplicate-fee-heads/load';
import {
  applyCleanup,
  planCleanup,
} from '../../src/modules/student-fees/duplicate-fee-heads/cleanup';
import {
  expectedDelta,
  feeHeadsCheck,
} from '../../src/modules/student-fees/duplicate-fee-heads/reconcile';

let app: INestApplication;
let prisma: PrismaService;

beforeAll(async () => {
  ({ app, prisma } = await bootApp());
  await seedSchool(prisma);
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "audit_logs", "deposit_allocations", "deposits", "voucher_heads", "vouchers", "student_fees" RESTART IDENTITY CASCADE',
  );
});

const fee = (
  studentId: number,
  over: Partial<Prisma.student_feesUncheckedCreateInput> = {},
) =>
  prisma.student_fees.create({
    data: {
      student_id: studentId,
      fee_type_id: FEE.MTF,
      academic_year: YEAR,
      target_month: 9,
      month: 9,
      fee_date: new Date('2026-09-01'),
      amount: new Prisma.Decimal(18995),
      status: 'NOT_ISSUED',
      ...over,
    },
  });

/** Pay a head in full through a deposit, the way recordDeposit leaves it. */
async function payInFull(studentId: number, feeId: number, voucherId: number) {
  const f = await prisma.student_fees.findUniqueOrThrow({
    where: { id: feeId },
  });
  const deposit = await prisma.deposits.create({
    data: { student_id: studentId, total_amount: f.amount! },
  });
  await prisma.deposit_allocations.create({
    data: {
      deposit_id: deposit.id,
      student_fee_id: feeId,
      voucher_id: voucherId,
      amount: f.amount!,
      type: 'FEE_HEAD',
    },
  });
  await prisma.student_fees.update({
    where: { id: feeId },
    data: { status: 'PAID', amount_paid: f.amount! },
  });
  await prisma.voucher_heads.updateMany({
    where: { student_fee_id: feeId },
    data: { amount_deposited: f.amount!, balance: 0 },
  });
  await prisma.vouchers.update({
    where: { id: voucherId },
    data: { status: 'PAID' },
  });
  return deposit.id;
}

async function seedShapes() {
  // A1: a voucher split on one fee date, and a whole year on another. Not duplicates.
  const balance = await fee(STUDENT.A1, {
    amount: new Prisma.Decimal(8995),
    description_prefix: 'BALANCE PAYMENT OF',
  });
  const v1 = await issueVoucher(prisma, STUDENT.A1, [balance.id]);
  const partial = await fee(STUDENT.A1, {
    amount: new Prisma.Decimal(10000),
    amount_paid: new Prisma.Decimal(10000),
    status: 'PAID',
    description_prefix: 'PARTIAL PAYMENT OF',
    split_pair_id: balance.id,
  });
  for (const m of [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7]) {
    await fee(STUDENT.A1, {
      fee_type_id: FEE.ANNUAL,
      target_month: m,
      month: m,
      fee_date: new Date('2026-08-01'),
      amount: new Prisma.Decimal(500),
    });
  }

  // A2: two unbilled copies of August (DUP_UNBILLED), and October on a live
  // voucher beside an unbilled copy (DUP_ONE_BILLED).
  const augA = await fee(STUDENT.A2, {
    target_month: 8,
    month: 8,
    fee_date: new Date('2026-08-01'),
  });
  const augB = await fee(STUDENT.A2, {
    target_month: 8,
    month: 8,
    fee_date: new Date('2026-08-01'),
  });
  const octUnbilled = await fee(STUDENT.A2, {
    target_month: 10,
    month: 10,
    fee_date: new Date('2026-10-01'),
  });
  const octBilled = await fee(STUDENT.A2, {
    target_month: 10,
    month: 10,
    fee_date: new Date('2026-10-01'),
  });
  const vOct = await issueVoucher(prisma, STUDENT.A2, [octBilled.id]);

  // B1: both copies of September paid (DUP_NEEDS_REVERSAL), and an unbilled
  // copy of November sitting on a VOID voucher beside a clean one (UNCLEAR).
  const sepA = await fee(STUDENT.B1);
  const sepB = await fee(STUDENT.B1);
  const vSepA = await issueVoucher(prisma, STUDENT.B1, [sepA.id]);
  await payInFull(STUDENT.B1, sepA.id, vSepA);
  const vSepB = await issueVoucher(prisma, STUDENT.B1, [sepB.id]);
  const depB = await payInFull(STUDENT.B1, sepB.id, vSepB);
  const novA = await fee(STUDENT.B1, {
    target_month: 11,
    month: 11,
    fee_date: new Date('2026-11-01'),
  });
  const novB = await fee(STUDENT.B1, {
    target_month: 11,
    month: 11,
    fee_date: new Date('2026-11-01'),
  });
  const vVoid = await issueVoucher(prisma, STUDENT.B1, [novB.id]);
  await prisma.vouchers.update({
    where: { id: vVoid },
    data: { status: 'VOID' },
  });
  await prisma.student_fees.update({
    where: { id: novB.id },
    data: { status: 'NOT_ISSUED' },
  });

  return {
    balance,
    partial,
    v1,
    augA,
    augB,
    octUnbilled,
    octBilled,
    vOct,
    sepA,
    sepB,
    depB,
    novA,
    novB,
  };
}

const verdictOf = (
  groups: Awaited<ReturnType<typeof loadAudit>>['groups'],
  studentId: number,
  feeDate: string,
  feeType: number = FEE.MTF,
) =>
  groups.find(
    (g) =>
      g.kind === 'same_fee_date' &&
      g.student_id === studentId &&
      g.fee_date === feeDate &&
      g.fee_type_id === feeType,
  )?.verdict;

describe('duplicate fee head audit', () => {
  it('tells splits and whole years apart from real duplicates', async () => {
    await seedShapes();
    const { groups, students } = await loadAudit(prisma as any);
    expect(verdictOf(groups, STUDENT.A1, '2026-09-01')).toBe('LEGIT');
    expect(verdictOf(groups, STUDENT.A1, '2026-08-01', FEE.ANNUAL)).toBe(
      'LEGIT',
    );
    expect(verdictOf(groups, STUDENT.A2, '2026-08-01')).toBe('DUP_UNBILLED');
    expect(verdictOf(groups, STUDENT.A2, '2026-10-01')).toBe('DUP_ONE_BILLED');
    expect(verdictOf(groups, STUDENT.B1, '2026-09-01')).toBe(
      'DUP_NEEDS_REVERSAL',
    );
    expect(verdictOf(groups, STUDENT.B1, '2026-11-01')).toBe('UNCLEAR');
    expect(students.get(STUDENT.A2)?.full_name).toBe('Test Student Two');
  });

  it('writes nothing while loading (read-only transaction)', async () => {
    await seedShapes();
    const count = await prisma.student_fees.count();
    await loadAudit(prisma as any);
    expect(await prisma.student_fees.count()).toBe(count);
    expect(await prisma.audit_logs.count()).toBe(0);
  });
});

describe('duplicate fee head cleanup', () => {
  it('deletes only the unbilled extra copies, logs each, and the Fee Heads report still reconciles', async () => {
    const s = await seedShapes();
    const before = await feeHeadsCheck(prisma as any);
    expect(before.reconciles).toBe(true);

    const plan = planCleanup((await loadAudit(prisma as any)).groups);
    expect(
      plan.removals.map((r) => r.student_fee_id).sort((a, b) => a - b),
    ).toEqual([s.augB.id, s.octUnbilled.id]);
    expect(plan.manual.map((g) => g.student_id)).toEqual([
      STUDENT.B1,
      STUDENT.B1,
    ]);

    const result = await applyCleanup(prisma as any, plan, {
      changedBy: 'db-spec',
      reason: 'test',
    });
    expect(result.skipped).toEqual([]);
    expect(result.removed).toHaveLength(2);

    const left = new Set(
      (await prisma.student_fees.findMany({ select: { id: true } })).map(
        (r) => r.id,
      ),
    );
    expect(left.has(s.augB.id)).toBe(false);
    expect(left.has(s.octUnbilled.id)).toBe(false);
    for (const kept of [
      s.augA,
      s.octBilled,
      s.balance,
      s.partial,
      s.sepA,
      s.sepB,
      s.novA,
      s.novB,
    ])
      expect(left.has(kept.id)).toBe(true);

    // Vouchers and deposits are untouched.
    expect(
      await prisma.vouchers.findUnique({ where: { id: s.vOct } }),
    ).toMatchObject({ status: 'UNPAID' });
    expect(await prisma.deposits.count()).toBe(2);
    expect(await prisma.deposit_allocations.count()).toBe(2);

    const logs = await prisma.audit_logs.findMany({
      where: { action: 'DELETED' },
      orderBy: { id: 'asc' },
    });
    expect(logs.map((l) => l.entity_id).sort()).toEqual(
      [String(s.augB.id), String(s.octUnbilled.id)].sort(),
    );
    expect(
      logs.every(
        (l) =>
          l.note?.startsWith('TAFSD-546 duplicate cleanup') &&
          l.changed_by === 'db-spec',
      ),
    ).toBe(true);

    const after = await feeHeadsCheck(prisma as any);
    expect(after.reconciles).toBe(true);
    expect(expectedDelta(before.totals, after.totals, 18995 * 2, 2)).toEqual(
      [],
    );

    // Run again: nothing left to do.
    expect(
      planCleanup((await loadAudit(prisma as any)).groups).removals,
    ).toEqual([]);
  });

  it('skips a copy that was billed after the audit instead of forcing it', async () => {
    const s = await seedShapes();
    const plan = planCleanup((await loadAudit(prisma as any)).groups);
    // Someone issues a voucher for the "extra" August copy before the cleanup runs.
    await issueVoucher(prisma, STUDENT.A2, [s.augB.id]);

    const result = await applyCleanup(prisma as any, plan, {
      changedBy: 'db-spec',
      reason: 'test',
    });
    expect(result.removed.map((r) => r.student_fee_id)).toEqual([
      s.octUnbilled.id,
    ]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        student_fee_id: s.augB.id,
        reason: 'status is now ISSUED',
      }),
    ]);
    expect(
      await prisma.student_fees.findUnique({ where: { id: s.augB.id } }),
    ).not.toBeNull();
  });
});
