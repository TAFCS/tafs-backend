// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { VouchersService } from './vouchers.service';

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
      );

      jest
        .spyOn(service as any, 'computeArrears')
        .mockResolvedValue({ arrear_fee_ids: [], surcharge_groups: [] } as any);
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
          data: { status: 'VOID' },
        }),
      );
    });
  });
});
