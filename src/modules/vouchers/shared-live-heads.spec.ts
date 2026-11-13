// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { VouchersService } from './vouchers.service';

/**
 * TAFSD-511 (CC 8144): a fee head is billed on one live voucher at a time.
 *
 * Dec voucher #14238 (Nov + Dec heads) was issued, then a Nov voucher #14239
 * for the Nov heads. Supersession only voids vouchers on or before the new fee
 * date, so #14238 stayed live; #14239 was paid and #14238 went on billing the
 * Nov heads. Force-deleting #14238 would then have un-paid them.
 */
describe('VouchersService — one live voucher per fee head (TAFSD-511)', () => {
  const auditLogs = { log: jest.fn().mockResolvedValue({}) };
  const svc = (prisma: any = {}) =>
    new VouchersService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      auditLogs as any,
      {} as any,
      {} as any,
    );

  describe('_assertHeadsNotOnOtherLiveVoucher', () => {
    it('refuses a head still owed on a later live voucher, naming it', async () => {
      const findMany = jest.fn().mockResolvedValue([
        {
          voucher_id: 14238,
          student_fees: {
            id: 37182,
            fee_date: new Date('2026-11-01'),
            fee_types: { description: 'Tuition Fee' },
          },
          vouchers: {
            voucher_number: '1226-14238',
            fee_date: new Date('2026-12-01'),
            status: 'UNPAID',
          },
        },
      ]);
      const tx: any = { voucher_heads: { findMany } };

      const run = (svc() as any)._assertHeadsNotOnOtherLiveVoucher(
        tx,
        [37182, 37183],
        [14100],
      );
      await expect(run).rejects.toBeInstanceOf(BadRequestException);
      await expect(run).rejects.toThrow(
        /voucher #14238.*fee date 2026-12-01.*Tuition Fee/,
      );

      const where = findMany.mock.calls[0][0].where;
      expect(where.student_fee_id).toEqual({ in: [37182, 37183] });
      // The vouchers this issue supersedes are allowed to hold them.
      expect(where.voucher_id).toEqual({ notIn: [14100] });
      expect(where.vouchers).toEqual({
        status: { in: ['UNPAID', 'OVERDUE', 'EXPIRED', 'PARTIALLY_PAID'] },
      });
      // Paid, waived and discount heads are not owed, so they never clash.
      expect(where.student_fees).toEqual({
        is_discount: false,
        status: { notIn: ['PAID', 'WAIVED', 'DISCOUNT'] },
      });
    });

    it('passes when no other live voucher holds the heads', async () => {
      const tx: any = {
        voucher_heads: { findMany: jest.fn().mockResolvedValue([]) },
      };
      await expect(
        (svc() as any)._assertHeadsNotOnOtherLiveVoucher(tx, [1, 2], []),
      ).resolves.toBeUndefined();
      // No supersession: no voucher_id filter at all (notIn [] is not sent).
      expect(
        tx.voucher_heads.findMany.mock.calls[0][0].where.voucher_id,
      ).toBeUndefined();
    });

    it('does not query for an empty head list', async () => {
      const tx: any = { voucher_heads: { findMany: jest.fn() } };
      await (svc() as any)._assertHeadsNotOnOtherLiveVoucher(tx, [], []);
      expect(tx.voucher_heads.findMany).not.toHaveBeenCalled();
    });
  });

  describe('forceRemove — heads held by another voucher', () => {
    // #14238 EXPIRED: Nov heads 37182/37183 (paid through #14239) + Dec head 37184.
    const build = () => {
      const voucher = {
        id: 14238,
        student_id: 8144,
        status: 'EXPIRED',
        voucher_number: '1226-14238',
        voucher_heads: [
          {
            student_fee_id: 37182,
            student_fees: { id: 37182, fee_date: new Date('2026-11-01') },
          },
          {
            student_fee_id: 37183,
            student_fees: { id: 37183, fee_date: new Date('2026-11-01') },
          },
          {
            student_fee_id: 37184,
            student_fees: { id: 37184, fee_date: new Date('2026-12-01') },
          },
        ],
      };
      const studentFeesUpdate = jest.fn().mockResolvedValue({});
      const studentFeesUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
      const tx: any = {
        voucher_heads: {
          // #14239 (PAID) carries the two Nov heads.
          findMany: jest
            .fn()
            .mockResolvedValue([
              { student_fee_id: 37182 },
              { student_fee_id: 37183 },
            ]),
          deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
        },
        deposit_allocations: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          // Deposit #6131 on #14239 still pays both Nov heads in full.
          groupBy: jest.fn().mockResolvedValue([
            { student_fee_id: 37182, _sum: { amount: 90000 } },
            { student_fee_id: 37183, _sum: { amount: 9975 } },
          ]),
        },
        student_fees: {
          findMany: jest.fn().mockResolvedValue([
            { id: 37182, amount: 90000, amount_paid: 90000, status: 'PAID' },
            { id: 37183, amount: 9975, amount_paid: 9975, status: 'PAID' },
          ]),
          update: studentFeesUpdate,
          updateMany: studentFeesUpdateMany,
        },
        vouchers: { delete: jest.fn().mockResolvedValue({ id: 14238 }) },
      };
      const prisma: any = {
        vouchers: { findUnique: jest.fn().mockResolvedValue(voucher) },
        deposit_allocations: { findFirst: jest.fn().mockResolvedValue(null) },
        $transaction: (fn: any) => fn(tx),
      };
      const service = svc(prisma);
      (service as any).canSeeVoucher = jest.fn().mockResolvedValue(true);
      return { service, tx, studentFeesUpdate, studentFeesUpdateMany };
    };

    it('resets only its own head and leaves the heads paid elsewhere PAID', async () => {
      const { service, tx, studentFeesUpdate, studentFeesUpdateMany } = build();
      await service.forceRemove(14238, 'tester');

      const heldQuery = tx.voucher_heads.findMany.mock.calls[0][0].where;
      expect(heldQuery.voucher_id).toEqual({ not: 14238 });
      expect(heldQuery.vouchers).toEqual({ status: { not: 'VOID' } });

      expect(studentFeesUpdateMany).toHaveBeenCalledTimes(1);
      expect(studentFeesUpdateMany.mock.calls[0][0].where).toEqual({
        id: { in: [37184] },
      });
      // Already PAID with the allocations that stand: nothing to write.
      expect(studentFeesUpdate).not.toHaveBeenCalled();

      const note = auditLogs.log.mock.calls.at(-1)[0].note as string;
      expect(note).toContain('Reset 1 fee head(s)');
      expect(note).toContain('Left 2 fee head(s) held by another voucher');
    });

    it('re-derives a held head from the allocations left, never zeroing a payment', async () => {
      const { service, tx, studentFeesUpdate } = build();
      // Only part of 37182 was paid through the other voucher; the rest was on this one.
      tx.deposit_allocations.groupBy.mockResolvedValue([
        { student_fee_id: 37182, _sum: { amount: 40000 } },
      ]);
      await service.forceRemove(14238, 'tester');

      expect(studentFeesUpdate).toHaveBeenCalledWith({
        where: { id: 37182 },
        data: {
          amount_paid: new Prisma.Decimal(40000),
          status: 'PARTIALLY_PAID',
        },
      });
      expect(studentFeesUpdate).toHaveBeenCalledWith({
        where: { id: 37183 },
        data: { amount_paid: new Prisma.Decimal(0), status: 'ISSUED' },
      });
    });
  });
});
