// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { VouchersService } from './vouchers.service';
import { Prisma } from '@prisma/client';

/**
 * Supersession rule under test (blunt, by fee date):
 *
 *   Generating a voucher voids EVERY open voucher for that student whose
 *   fee_date is on or before the new voucher's fee_date — full stop, no
 *   head-overlap test. Their still-outstanding heads are folded onto the new
 *   voucher so nothing is orphaned. PAID vouchers are untouched; PARTIALLY_PAID
 *   ones are split first (paid portion kept on its own PAID voucher, remainder
 *   voided and absorbed).
 */
describe('VouchersService — supersession by fee date', () => {
  const svc = () =>
    new VouchersService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any, // ScopeService — not exercised by these tests
    );

  const sf = (over: Partial<any> = {}) => ({
    is_discount: false,
    status: 'ISSUED',
    amount: 1000,
    amount_paid: 0,
    amount_before_discount: 1000,
    ...over,
  });

  describe('_planFeeDateSupersession', () => {
    it('voids a future-dated and an earlier voucher when a later one is generated', async () => {
      const vouchers = {
        findMany: jest.fn().mockResolvedValue([
          { id: 11, voucher_number: 'V11', status: 'UNPAID' }, // fee_date 2 Sep
          { id: 12, voucher_number: 'V12', status: 'OVERDUE' }, // fee_date 1 Sep
        ]),
      };
      const voucher_heads = {
        findMany: jest.fn().mockResolvedValue([
          { student_fee_id: 101, student_fees: sf() }, // 2 Sep head A
          { student_fee_id: 102, student_fees: sf() }, // 2 Sep head B
          { student_fee_id: 103, student_fees: sf() }, // 1 Sep head
        ]),
      };
      const tx: any = { vouchers, voucher_heads };

      const plan = await (svc() as any)._planFeeDateSupersession(
        tx,
        7000,
        new Date('2026-10-01'),
      );

      expect(plan.voidVoucherIds.sort()).toEqual([11, 12]);
      expect(plan.absorbFeeIds.sort()).toEqual([101, 102, 103]);

      // The query is scoped to this student, fee_date <= target, not-fully-paid only.
      const where = vouchers.findMany.mock.calls[0][0].where;
      expect(where.student_id).toBe(7000);
      expect(where.fee_date).toEqual({ lte: new Date('2026-10-01') });
      expect(where.status).toEqual({
        in: ['UNPAID', 'OVERDUE', 'EXPIRED', 'PARTIALLY_PAID'],
      });
    });

    it('voids a PARTIALLY_PAID predecessor and absorbs only its unpaid remainder', async () => {
      const tx: any = {
        vouchers: {
          findMany: jest.fn().mockResolvedValue([
            { id: 50, voucher_number: 'V50', status: 'PARTIALLY_PAID' },
          ]),
        },
        voucher_heads: {
          findMany: jest.fn().mockResolvedValue([
            // partly paid head: 1200 billed, 500 already paid -> 700 remainder
            {
              student_fee_id: 500,
              student_fees: sf({ status: 'PARTIALLY_PAID', amount: 1200, amount_paid: 500 }),
            },
            // a fully-paid head on the same voucher -> not carried forward
            {
              student_fee_id: 501,
              student_fees: sf({ status: 'PAID', amount: 800, amount_paid: 800 }),
            },
          ]),
        },
      };

      const plan = await (svc() as any)._planFeeDateSupersession(
        tx,
        7000,
        new Date('2026-10-01'),
      );

      expect(plan.voidVoucherIds).toEqual([50]);
      expect(plan.absorbFeeIds).toEqual([500]);
    });

    it('returns nothing when the student has no open vouchers on/before the fee date', async () => {
      const tx: any = {
        vouchers: { findMany: jest.fn().mockResolvedValue([]) },
        voucher_heads: { findMany: jest.fn() },
      };

      const plan = await (svc() as any)._planFeeDateSupersession(
        tx,
        7000,
        new Date('2026-09-01'),
      );

      expect(plan).toEqual({ voidVoucherIds: [], absorbFeeIds: [], meta: [] });
      expect(tx.voucher_heads.findMany).not.toHaveBeenCalled();
    });

    it('excludes discount heads, already-paid fees and fully-covered heads from the absorb set', async () => {
      const tx: any = {
        vouchers: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 20, voucher_number: 'V20', status: 'UNPAID' }]),
        },
        voucher_heads: {
          findMany: jest.fn().mockResolvedValue([
            { student_fee_id: 200, student_fees: sf() }, // ok
            { student_fee_id: 201, student_fees: sf({ is_discount: true }) }, // discount
            { student_fee_id: 202, student_fees: sf({ status: 'PAID' }) }, // paid
            { student_fee_id: 203, student_fees: sf({ amount: 500, amount_paid: 500 }) }, // covered
            { student_fee_id: null, student_fees: sf() }, // detached head
          ]),
        },
      };

      const plan = await (svc() as any)._planFeeDateSupersession(
        tx,
        7000,
        new Date('2026-10-01'),
      );

      expect(plan.voidVoucherIds).toEqual([20]);
      expect(plan.absorbFeeIds).toEqual([200]);
    });

    it('carries the partially-paid remainder (outstanding > 0) as an absorbed head', async () => {
      const tx: any = {
        vouchers: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 30, voucher_number: 'V30', status: 'UNPAID' }]),
        },
        voucher_heads: {
          findMany: jest.fn().mockResolvedValue([
            { student_fee_id: 300, student_fees: sf({ amount: 1200, amount_paid: 500 }) },
          ]),
        },
      };

      const plan = await (svc() as any)._planFeeDateSupersession(
        tx,
        7000,
        new Date('2026-10-01'),
      );

      expect(plan.absorbFeeIds).toEqual([300]);
    });

    it('absorbs the head of a superseded split BALANCE child (precondition for delete-time reactivation)', async () => {
      // A voucher produced by splitPartiallyPaid(): status UNPAID, split_parent_id
      // set, its head a "BALANCE PAYMENT OF" student_fees row with an outstanding
      // balance. _planFeeDateSupersession does not care about the prefix/lineage —
      // it must still fold the balance head in so the new voucher carries it.
      const tx: any = {
        vouchers: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 40, voucher_number: 'V40-BAL', status: 'UNPAID' }]),
        },
        voucher_heads: {
          findMany: jest.fn().mockResolvedValue([
            {
              student_fee_id: 400,
              student_fees: sf({ status: 'ISSUED', amount: 700, amount_paid: 0 }),
            },
          ]),
        },
      };

      const plan = await (svc() as any)._planFeeDateSupersession(
        tx,
        7000,
        new Date('2026-10-01'),
      );

      expect(plan.voidVoucherIds).toEqual([40]);
      expect(plan.absorbFeeIds).toEqual([400]);
    });
  });

  describe('create() — end to end supersession', () => {
    const build = (opts: { openPredecessors?: any[] } = {}) => {
      const txVouchersUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const updatedVoucher = {
        id: 500,
        month: 9,
        total_payable_before_due: 1000,
        issue_date: new Date('2026-10-01'),
        voucher_number: 'V500',
        academic_year: '2026-2027',
      };

      const tx: any = {
        vouchers: {
          findMany: jest.fn().mockResolvedValue(
            opts.openPredecessors ?? [
              { id: 42, voucher_number: 'V42', status: 'UNPAID' },
            ],
          ),
          create: jest.fn().mockResolvedValue({ id: 500 }),
          update: jest.fn().mockResolvedValue(updatedVoucher),
          updateMany: txVouchersUpdateMany,
        },
        voucher_heads: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ student_fee_id: 4242, student_fees: sf() }]),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        student_fees: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 4242,
              is_discount: false,
              amount: 1000,
              amount_paid: 0,
              amount_before_discount: 1000,
              fee_type_id: 1,
              academic_year: '2026-2027',
              status: 'ISSUED',
              fee_types: { priority_order: 1 },
            },
          ]),
          update: jest.fn().mockResolvedValue({}),
        },
        bank_accounts: { findFirst: jest.fn().mockResolvedValue({ id: 1, is_default: true }) },
        voucher_arrear_surcharges: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      };

      const prisma: any = {
        students: { findUnique: jest.fn().mockResolvedValue({ gr_number: 'GR1' }) },
        $transaction: jest.fn(async (cb: any) => cb(tx)),
      };

      const auditLogs: any = { log: jest.fn(), logGroup: jest.fn() };
      const notifier: any = { sendVoucherIssuedNotification: jest.fn().mockResolvedValue(undefined) };

      const service = new VouchersService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
        auditLogs,
        notifier,
        {} as any, // ScopeService — not exercised by these tests
      );

      jest
        .spyOn(service as any, 'computeArrears')
        .mockResolvedValue({ arrear_fee_ids: [], surcharge_groups: [], rows: [] } as any);
      jest.spyOn(service as any, 'buildScheduleGrossMap').mockResolvedValue(new Map());
      jest.spyOn(service as any, 'resolveGeneratedByName').mockResolvedValue('Tester');

      return { service, prisma, tx, txVouchersUpdateMany };
    };

    const dto = {
      student_id: 7000,
      campus_id: 1,
      class_id: 3,
      bank_account_id: 1,
      issue_date: '2026-10-01',
      due_date: '2026-10-10',
      validity_date: '2026-10-15',
      fee_date: '2026-10-01',
      late_fee_charge: false,
      orderedFeeIds: [4242],
      fee_lines: [],
      send_notification: false,
    } as any;

    it('voids every not-fully-paid predecessor by fee date, PARTIALLY_PAID included', async () => {
      const { service, txVouchersUpdateMany } = build({
        openPredecessors: [
          { id: 42, voucher_number: 'V42', status: 'UNPAID' },
          { id: 43, voucher_number: 'V43', status: 'PARTIALLY_PAID' },
        ],
      });

      await service.create(dto);

      expect(txVouchersUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: [42, 43] } }),
          // The superseding voucher's id is stamped so delete-time reactivation
          // (_destroyVoucherInTx STEP 1) is exact rather than head-overlap guesswork.
          data: { status: 'VOID', superseded_by_voucher_id: 500 },
        }),
      );
    });
  });

  describe('_destroyVoucherInTx — delete-time reactivation', () => {
    it('reactivates a predecessor by the superseded_by link even when head-overlap fails (discount head)', async () => {
      const vouchersUpdate = jest.fn().mockResolvedValue({ id: 42, voucher_number: 'V42' });
      const linkedFindMany = jest.fn().mockResolvedValue([
        { id: 42, due_date: new Date('2020-01-01') }, // long past due -> OVERDUE
      ]);

      const tx: any = {
        vouchers: {
          findMany: linkedFindMany,
          update: vouchersUpdate,
          delete: jest.fn().mockResolvedValue({ id: 500, voucher_number: 'V500' }),
        },
        voucher_heads: {
          // STEP 1 fallback-heuristic queries + STEP 6 reactivated-head lookup + STEP 4 delete
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        deposit_allocations: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          groupBy: jest.fn().mockResolvedValue([]),
          aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
        },
        voucher_arrear_surcharges: { findMany: jest.fn().mockResolvedValue([]) },
        student_fees: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          findFirst: jest.fn(),
          findUnique: jest.fn(),
        },
      };

      // The voucher being deleted (V500) carries one regular head; V42 (VOID,
      // superseded_by = 500) also carries a *discount* head that was never
      // absorbed, so the old containment heuristic would never reactivate it.
      const deleted = {
        id: 500,
        student_id: 7000,
        voucher_number: 'V500',
        fee_date: new Date('2026-10-01'),
        voucher_heads: [
          { student_fee_id: 4242, student_fees: { fee_date: new Date('2026-10-01'), description_prefix: null } },
        ],
      };

      const auditEvents: any[] = [];
      await (svc() as any)._destroyVoucherInTx(500, deleted, tx, true, auditEvents);

      expect(linkedFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ superseded_by_voucher_id: 500, status: 'VOID' }),
        }),
      );
      expect(vouchersUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 42 },
          data: { status: 'OVERDUE', superseded_by_voucher_id: null },
        }),
      );
      expect(auditEvents.some((e) => e.entity_id === '42' && e.new_value === 'OVERDUE')).toBe(true);
    });
  });


  // TAFSD-282: a head shared by the deleted voucher and a reactivated predecessor is
  // skipped by STEP 6's NOT_ISSUED reset, so it must be recomputed from the
  // allocations that survive — never left PAID with nothing backing it.
  describe('_destroyVoucherInTx — heads shared with a reactivated predecessor', () => {
    const build = (opts: { survivingOnFee: number; survivingOnPredecessor: number }) => {
      const studentFeesUpdate = jest.fn().mockResolvedValue({});
      const studentFeesUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const vouchersUpdate = jest.fn().mockResolvedValue({ id: 42, voucher_number: 'V42' });
      const voucherHeadsUpdate = jest.fn().mockResolvedValue({});

      const tx: any = {
        vouchers: {
          // STEP 1 link lookup: V42 (the rolled-over balance voucher) was superseded by V500.
          findMany: jest.fn().mockResolvedValue([{ id: 42, due_date: new Date('2020-01-01') }]),
          update: vouchersUpdate,
          delete: jest.fn().mockResolvedValue({ id: 500, voucher_number: 'V500' }),
        },
        voucher_heads: {
          findMany: jest.fn().mockImplementation((args: any) => {
            // STEP 1 fallback overlap query — nothing extra.
            if (args?.where?.voucher_id?.not != null) return Promise.resolve([]);
            // reactivatedHeadFeeIds lookup: V42 owns the 1,000 balance head.
            if (args?.where?.voucher_id?.in) return Promise.resolve([{ student_fee_id: 102 }]);
            // V42's own heads, for the predecessor recompute.
            if (args?.where?.voucher_id === 42) {
              return Promise.resolve([{ id: 20, student_fee_id: 102, net_amount: 1000 }]);
            }
            return Promise.resolve([]);
          }),
          deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          update: voucherHeadsUpdate,
        },
        deposit_allocations: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          groupBy: jest.fn().mockImplementation((args: any) => {
            if (args?.where?.voucher_id === 42) {
              return Promise.resolve(opts.survivingOnPredecessor > 0
                ? [{ student_fee_id: 102, _sum: { amount: opts.survivingOnPredecessor } }]
                : []);
            }
            return Promise.resolve(opts.survivingOnFee > 0
              ? [{ student_fee_id: 102, _sum: { amount: opts.survivingOnFee } }]
              : []);
          }),
          aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
        },
        voucher_arrear_surcharges: { findMany: jest.fn().mockResolvedValue([]) },
        student_fees: {
          // Left PAID by the deposit that clearDeposit has just removed.
          findMany: jest.fn().mockResolvedValue([
            { id: 102, amount: 1000, amount_paid: 1000, status: 'PAID' },
          ]),
          update: studentFeesUpdate,
          updateMany: studentFeesUpdateMany,
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          findFirst: jest.fn(),
          findUnique: jest.fn(),
        },
      };

      // V500: 90,000 tuition (Oct) + the 1,000 BALANCE head rolled onto Oct.
      const deleted = {
        id: 500,
        student_id: 7000,
        voucher_number: 'V500',
        fee_date: new Date('2026-10-01'),
        voucher_heads: [
          { student_fee_id: 101, student_fees: { fee_date: new Date('2026-10-01'), description_prefix: null } },
          { student_fee_id: 102, student_fees: { fee_date: new Date('2026-10-01'), description_prefix: 'BALANCE PAYMENT OF TUITION' } },
        ],
      };

      return { tx, deleted, studentFeesUpdate, studentFeesUpdateMany, vouchersUpdate, voucherHeadsUpdate };
    };

    it('recomputes the shared head to ISSUED / amount_paid 0 and reactivates the predecessor OVERDUE', async () => {
      const { tx, deleted, studentFeesUpdate, studentFeesUpdateMany, vouchersUpdate } =
        build({ survivingOnFee: 0, survivingOnPredecessor: 0 });

      await (svc() as any)._destroyVoucherInTx(500, deleted, tx, true, []);

      // STEP 6 resets only the 90,000 head; the shared head is left to STEP 6b.
      expect(studentFeesUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: [101] } } }),
      );
      expect(studentFeesUpdate).toHaveBeenCalledWith({
        where: { id: 102 },
        data: { amount_paid: new Prisma.Decimal(0), status: 'ISSUED' },
      });
      expect(vouchersUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 42 },
          data: { status: 'OVERDUE', superseded_by_voucher_id: null },
        }),
      );
    });

    it('keeps a surviving payment and reactivates the predecessor PARTIALLY_PAID', async () => {
      const { tx, deleted, studentFeesUpdate, vouchersUpdate, voucherHeadsUpdate } =
        build({ survivingOnFee: 400, survivingOnPredecessor: 400 });

      await (svc() as any)._destroyVoucherInTx(500, deleted, tx, true, []);

      expect(studentFeesUpdate).toHaveBeenCalledWith({
        where: { id: 102 },
        data: { amount_paid: new Prisma.Decimal(400), status: 'PARTIALLY_PAID' },
      });
      expect(voucherHeadsUpdate).toHaveBeenCalledWith({
        where: { id: 20 },
        data: { amount_deposited: new Prisma.Decimal(400), balance: new Prisma.Decimal(600) },
      });
      expect(vouchersUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 42 },
          data: { status: 'PARTIALLY_PAID', superseded_by_voucher_id: null },
        }),
      );
    });
  });

  // ── The reactivation gate in remove() ──────────────────────────────────────
  // Regression: EXPIRED used to be lumped in with VOID here, so deleting an
  // expired voucher reactivated nothing and stranded its predecessor as VOID
  // permanently — the predecessor's superseded_by_voucher_id kept pointing at
  // the deleted row (no FK backs that column) and STEP 1 only ever searches by
  // the id being deleted, so no later delete could ever find it again.
  //
  // EXPIRED is a LIVE voucher whose validity window merely closed (the cron
  // promotes UNPAID/OVERDUE -> EXPIRED); it never superseded anything, so it
  // must reactivate. VOID is the only status that must not: something newer is
  // still standing in its place, and reactivating its predecessors would
  // double-bill the same heads.
  describe('remove() — which deletions reactivate the superseded predecessor', () => {
    const buildRemove = (status: string) => {
      const destroy = jest.fn().mockResolvedValue({ id: 500 });
      const prisma: any = {
        vouchers: {
          findUnique: jest.fn().mockResolvedValue({
            id: 500,
            student_id: 7000,
            voucher_number: 'V500',
            status,
            voucher_heads: [],
          }),
          // remove() refuses anything but the student's most recent voucher
          findFirst: jest.fn().mockResolvedValue({ id: 500 }),
        },
        $transaction: (fn: any) => fn({} as any),
      };
      const auditLogs: any = { log: jest.fn().mockResolvedValue(1) };
      const service = new VouchersService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
        auditLogs,
        {} as any,
        {} as any, // ScopeService
      );
      (service as any)._destroyVoucherInTx = destroy;
      return { service, destroy };
    };

    // _destroyVoucherInTx(id, voucher, tx, reactivate, auditEvents)
    const reactivateArg = (destroy: jest.Mock) => destroy.mock.calls[0][3];

    it.each(['UNPAID', 'OVERDUE', 'EXPIRED'])(
      'reactivates the predecessor when deleting a %s voucher',
      async (status) => {
        const { service, destroy } = buildRemove(status);
        await service.remove(500, 'tester');
        expect(reactivateArg(destroy)).toBe(true);
      },
    );

    it('does NOT reactivate when deleting a VOID voucher — a newer voucher still supersedes its predecessors', async () => {
      const { service, destroy } = buildRemove('VOID');
      await service.remove(500, 'tester');
      expect(reactivateArg(destroy)).toBe(false);
    });
  });

  describe('clearDeposit() — clearing deposit on voucher carrying rolled-over BALANCE head', () => {
    it('recomputes V3 (UNPAID/OVERDUE, heads ISSUED with amount_paid 0) and does NOT hard-delete or reactivate predecessors', async () => {
      const v3Heads = [
        {
          id: 1,
          student_fee_id: 101,
          net_amount: 90000,
          amount_deposited: 90000,
          balance: 0,
          student_fees: {
            id: 101,
            amount: 90000,
            amount_paid: 90000,
            status: 'PAID',
            is_discount: false,
            description_prefix: null,
          },
        },
        {
          id: 2,
          student_fee_id: 102,
          net_amount: 1000,
          amount_deposited: 1000,
          balance: 0,
          student_fees: {
            id: 102,
            amount: 1000,
            amount_paid: 1000,
            status: 'PAID',
            is_discount: false,
            description_prefix: 'BALANCE PAYMENT OF TUITION',
          },
        },
      ];

      const v3 = {
        id: 300,
        student_id: 7000,
        status: 'PAID',
        split_parent_id: null, // Generated by create(), not a split child
        generated_at: new Date('2026-10-01'),
        issue_date: new Date('2026-10-01'),
        due_date: new Date('2026-10-10'),
        voucher_heads: v3Heads,
      };

      const deposit = {
        id: 999,
        student_id: 7000,
        total_amount: 91000,
        reference_number: 'DEP999',
      };

      const txStudentFeesUpdate = jest.fn().mockResolvedValue({});
      const txVouchersUpdate = jest.fn().mockResolvedValue({ id: 300, status: 'UNPAID' });
      const txVouchersDelete = jest.fn();

      const tx: any = {
        deposit_allocations: {
          findMany: jest.fn().mockResolvedValue([
            { deposit_id: 999, voucher_id: 300, student_fee_id: 101, amount: 90000 },
            { deposit_id: 999, voucher_id: 300, student_fee_id: 102, amount: 1000 },
          ]),
          deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
          count: jest.fn().mockResolvedValue(0), // remainingOnDeposit = 0, remainingOnVoucher = 0
          groupBy: jest.fn().mockResolvedValue([]),
          aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
        },
        deposits: {
          delete: jest.fn().mockResolvedValue({ id: 999 }),
        },
        student_fees: {
          findMany: jest.fn().mockResolvedValue([
            { id: 101, amount: 90000, amount_paid: 90000, status: 'PAID' },
            { id: 102, amount: 1000, amount_paid: 1000, status: 'PAID' },
          ]),
          update: txStudentFeesUpdate,
        },
        voucher_heads: {
          findMany: jest.fn().mockImplementation((args) => {
            if (args?.include?.student_fees) {
              return Promise.resolve(v3Heads);
            }
            return Promise.resolve([
              { id: 1, student_fee_id: 101, net_amount: 90000 },
              { id: 2, student_fee_id: 102, net_amount: 1000 },
            ]);
          }),
          update: jest.fn().mockResolvedValue({}),
        },
        voucher_arrear_surcharges: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        vouchers: {
          findUnique: jest.fn().mockResolvedValue({
            id: 300,
            due_date: new Date('2026-10-10'),
            status: 'PAID',
            voucher_heads: [
              { id: 1, balance: 90000, amount_deposited: 0 },
              { id: 2, balance: 1000, amount_deposited: 0 },
            ],
          }),
          update: txVouchersUpdate,
          delete: txVouchersDelete,
        },
      };

      const prisma: any = {
        vouchers: {
          findUnique: jest.fn().mockResolvedValue(v3),
        },
        deposits: {
          findUnique: jest.fn().mockResolvedValue(deposit),
          findFirst: jest.fn().mockResolvedValue({ id: 999 }),
        },
        deposit_allocations: { findFirst: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(async (cb: any) => cb(tx)),
      };

      const auditLogs: any = { log: jest.fn().mockResolvedValue(1) };
      const service = new VouchersService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
        auditLogs,
        {} as any,
        {} as any,
      );

      const destroySpy = jest.spyOn(service as any, '_destroyVoucherInTx');
      jest.spyOn(service as any, 'findOne').mockResolvedValue({ id: 300, status: 'UNPAID' } as any);

      const result = await service.clearDeposit(300, 999, 'tester');

      // V3 must NOT be destroyed
      expect(destroySpy).not.toHaveBeenCalled();
      expect(txVouchersDelete).not.toHaveBeenCalled();

      // V3 must take the recompute path and be updated
      expect(txVouchersUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 300 },
          data: expect.objectContaining({
            status: expect.stringMatching(/^(UNPAID|OVERDUE)$/),
          }),
        }),
      );

      // Both fee heads must be reset to ISSUED with amount_paid = 0
      expect(txStudentFeesUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 101 },
          data: expect.objectContaining({ status: 'ISSUED' }),
        }),
      );
      expect(txStudentFeesUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 102 },
          data: expect.objectContaining({ status: 'ISSUED' }),
        }),
      );

      // findOne returns the recomputed voucher
      expect(result).toEqual({ id: 300, status: 'UNPAID' });
    });

    it('still takes the delete path for a legacy (pre-split_parent_id) split detected by its prefix', async () => {
      const legacy = {
        id: 310,
        student_id: 7000,
        status: 'PAID',
        split_parent_id: null,
        generated_at: new Date('2026-05-01'),
        issue_date: new Date('2026-05-01'),
        voucher_heads: [
          { id: 3, student_fee_id: 103, student_fees: { id: 103, description_prefix: 'PARTIAL PAYMENT OF TUITION' } },
        ],
      };
      const tx: any = {
        deposit_allocations: {
          findMany: jest.fn().mockResolvedValue([{ deposit_id: 777, voucher_id: 310, student_fee_id: 103, amount: 500 }]),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          count: jest.fn().mockResolvedValue(0),
        },
        deposits: { delete: jest.fn().mockResolvedValue({ id: 777 }) },
        voucher_heads: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const prisma: any = {
        vouchers: { findUnique: jest.fn().mockResolvedValue(legacy) },
        deposits: {
          findUnique: jest.fn().mockResolvedValue({ id: 777, student_id: 7000, total_amount: 500 }),
          findFirst: jest.fn().mockResolvedValue({ id: 777 }),
        },
        deposit_allocations: { findFirst: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(async (cb: any) => cb(tx)),
      };
      const service = new VouchersService(
        prisma, {} as any, {} as any, {} as any,
        { log: jest.fn().mockResolvedValue(1) } as any, {} as any, {} as any,
      );
      const destroy = jest.spyOn(service as any, '_destroyVoucherInTx').mockResolvedValue({ id: 310 });

      const result = await service.clearDeposit(310, 777, 'tester');

      expect(destroy).toHaveBeenCalledWith(310, legacy, tx, true, expect.any(Array));
      expect(result).toBeNull();
    });

    it('triggers full split-undo (_reverseSplitFamilyInTx) when voucher is a real split child with split_parent_id', async () => {
      const splitChild = {
        id: 400,
        student_id: 7000,
        status: 'PAID',
        split_parent_id: 200,
        generated_at: new Date('2026-10-01'),
        voucher_heads: [],
      };

      const deposit = {
        id: 888,
        student_id: 7000,
        total_amount: 5000,
      };

      const prisma: any = {
        vouchers: {
          findUnique: jest.fn().mockResolvedValue(splitChild),
        },
        deposits: {
          findUnique: jest.fn().mockResolvedValue(deposit),
          findFirst: jest.fn().mockResolvedValue({ id: 888 }),
        },
        deposit_allocations: { findFirst: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(async (cb: any) => cb({} as any)),
      };

      const auditLogs: any = { log: jest.fn().mockResolvedValue(1) };
      const service = new VouchersService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
        auditLogs,
        {} as any,
        {} as any,
      );

      const reverseSplitSpy = jest.spyOn(service as any, '_reverseSplitFamilyInTx').mockResolvedValue(true);

      const result = await service.clearDeposit(400, 888, 'tester');

      expect(reverseSplitSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 400, split_parent_id: 200 }),
        888,
        expect.anything(),
        expect.anything(),
      );
      expect(result).toBeNull();
    });
  });
});
