// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { Prisma } from '@prisma/client';
import { VouchersService } from './vouchers.service';
import { MeezanService } from '../meezan/meezan.service';

/**
 * TAFSD-269 — waiving is post-issuance only, and a waive writes off everything
 * still owed on the challan:
 * - a part-paid head keeps its cash and waives only the remainder;
 * - missed installments the challan prints are attached and waived too;
 * - un-waive is latest-voucher-only and restores PARTIALLY_PAID where cash exists;
 * - a WAIVED voucher can't be force-deleted, have its deposits reversed, or be
 *   paid at Meezan.
 */
const D = (n: number) => new Prisma.Decimal(n);

const fee = (over: any = {}) => ({
  id: 1,
  student_id: 500,
  is_discount: false,
  status: 'ISSUED',
  amount: D(10000),
  amount_before_discount: D(10000),
  amount_paid: D(0),
  academic_year: '2026-2027',
  description_prefix: null,
  ...over,
});

const head = (sf: any, over: any = {}) => ({
  id: sf.id * 10,
  student_fee_id: sf.id,
  waived: false,
  amount_deposited: D(0),
  net_amount: D(Number(sf.amount) - Number(sf.amount_paid)),
  student_fees: sf,
  ...over,
});

const voucherRow = (over: any = {}) => ({
  id: 77,
  student_id: 500,
  voucher_number: '10260000077',
  status: 'OVERDUE',
  campus_id: 1,
  class_id: 4,
  section_id: 1,
  academic_year: '2026-2027',
  month: 9,
  fee_date: new Date('2026-09-01'),
  issue_date: new Date('2026-09-01'),
  due_date: new Date('2026-09-10'),
  validity_date: new Date('2026-09-30'),
  voucher_heads: [],
  ...over,
});

function build(voucher: any, opts: { installments?: any[]; newer?: any; surchargesPaid?: number } = {}) {
  const tx: any = {
    student_fees: { update: jest.fn().mockResolvedValue({}), updateMany: jest.fn() },
    voucher_heads: { create: jest.fn().mockResolvedValue({}) },
    voucher_arrear_surcharges: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    vouchers: { update: jest.fn().mockResolvedValue({}) },
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  const prisma: any = {
    vouchers: {
      findUnique: jest.fn().mockResolvedValue(voucher),
      findFirst: jest.fn().mockResolvedValue(opts.newer ?? null),
    },
    student_fees: { findMany: jest.fn().mockResolvedValue(opts.installments ?? []) },
    voucher_heads: { findMany: jest.fn().mockResolvedValue([]) },
    voucher_arrear_surcharges: { count: jest.fn().mockResolvedValue(opts.surchargesPaid ?? 0) },
    classes: { findMany: jest.fn().mockResolvedValue([{ id: 4, term_start_month: 8 }]) },
    deposit_allocations: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const auditLogs: any = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new VouchersService(prisma, {} as any, {} as any, {} as any, auditLogs, {} as any, {} as any);
  // The PDF render and the read-back are outside what these tests pin.
  jest.spyOn(service as any, 'generatePdf').mockResolvedValue({ pdf_url: 'x', filename: 'x' });
  jest.spyOn(service, 'findOne').mockResolvedValue({ id: voucher.id } as any);
  return { service, prisma, tx, auditLogs };
}

describe('waiveVoucher', () => {
  it('waives only the unpaid remainder of a part-paid head and leaves paid heads alone', async () => {
    const partPaid = fee({ id: 1, status: 'PARTIALLY_PAID', amount_paid: D(4000) });
    const unpaid = fee({ id: 2 });
    const paid = fee({ id: 3, status: 'PAID', amount_paid: D(10000) });
    const v = voucherRow({
      status: 'PARTIALLY_PAID',
      voucher_heads: [head(partPaid, { amount_deposited: D(4000) }), head(unpaid), head(paid)],
    });
    const { service, tx } = build(v);

    await service.waiveVoucher(77, 'hardship', 'admin');

    const updates = tx.student_fees.update.mock.calls.map((c: any[]) => c[0]);
    expect(updates.map((u: any) => u.where.id).sort()).toEqual([1, 2]);
    const byId = new Map(updates.map((u: any) => [u.where.id, u.data]));
    expect(String((byId.get(1) as any).waived_amount)).toBe('6000');
    expect(String((byId.get(2) as any).waived_amount)).toBe('10000');
    expect((byId.get(1) as any).status).toBe('WAIVED');
    // amount_paid is never touched — the cash stays booked.
    expect((byId.get(1) as any).amount_paid).toBeUndefined();
    expect(tx.vouchers.update.mock.calls[0][0].data.status).toBe('WAIVED');
  });

  it('attaches missed installments to the voucher, waives them and grows the totals', async () => {
    const current = fee({ id: 2 });
    const plan = { fee_type_id: 9 };
    const missedInstallment = fee({
      id: 40,
      status: 'NOT_ISSUED',
      installment_id: 3,
      fee_type_id: 9,
      student_fee_installments: plan,
      amount: D(2500),
      fee_date: new Date('2026-08-01'),
      target_month: 8,
    });
    const futureInstallment = fee({
      id: 41,
      status: 'NOT_ISSUED',
      installment_id: 3,
      fee_type_id: 9,
      student_fee_installments: plan,
      amount: D(2500),
      fee_date: new Date('2026-10-01'),
      target_month: 10,
    });
    const v = voucherRow({ voucher_heads: [head(current)] });
    const { service, tx } = build(v, { installments: [missedInstallment, futureInstallment] });

    await service.waiveVoucher(77, undefined, 'admin');

    expect(tx.voucher_heads.create).toHaveBeenCalledTimes(1);
    const created = tx.voucher_heads.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ voucher_id: 77, student_fee_id: 40, waived: true });
    expect(String(created.net_amount)).toBe('2500');
    const waivedIds = tx.student_fees.update.mock.calls.map((c: any[]) => c[0].where.id).sort();
    expect(waivedIds).toEqual([2, 40]); // never the future installment
    const vData = tx.vouchers.update.mock.calls[0][0].data;
    expect(String(vData.total_payable_before_due.increment)).toBe('2500');
    expect(String(vData.total_arrears.increment)).toBe('2500');
  });

  it('rejects a voucher that is already waived, void or paid', async () => {
    for (const status of ['WAIVED', 'VOID', 'PAID']) {
      const { service } = build(voucherRow({ status, voucher_heads: [head(fee())] }));
      await expect(service.waiveVoucher(77, undefined, 'admin')).rejects.toThrow();
    }
  });
});

describe('unwaiveVoucher', () => {
  it('refuses when a newer live voucher exists for the student', async () => {
    const v = voucherRow({ status: 'WAIVED', voucher_heads: [head(fee({ status: 'WAIVED' }), { waived: true })] });
    const { service, tx } = build(v, { newer: { id: 90, voucher_number: '10260000090' } });

    await expect(service.unwaiveVoucher(77, 'admin')).rejects.toThrow(/latest voucher/);
    expect(tx.student_fees.update).not.toHaveBeenCalled();
  });

  it('restores part-paid heads to PARTIALLY_PAID and the voucher to PARTIALLY_PAID', async () => {
    const partPaid = fee({ id: 1, status: 'WAIVED', amount_paid: D(4000) });
    const unpaid = fee({ id: 2, status: 'WAIVED' });
    const v = voucherRow({
      status: 'WAIVED',
      voucher_heads: [
        head(partPaid, { waived: true, amount_deposited: D(4000) }),
        head(unpaid, { waived: true }),
      ],
    });
    const { service, tx } = build(v);

    await service.unwaiveVoucher(77, 'admin');

    const byId = new Map(tx.student_fees.update.mock.calls.map((c: any[]) => [c[0].where.id, c[0].data]));
    expect((byId.get(1) as any).status).toBe('PARTIALLY_PAID');
    expect((byId.get(2) as any).status).toBe('ISSUED');
    expect((byId.get(1) as any).waived_amount).toBeNull();
    expect(tx.vouchers.update.mock.calls[0][0].data.status).toBe('PARTIALLY_PAID');
  });

  it('returns an untouched voucher to OVERDUE when past due', async () => {
    const v = voucherRow({
      status: 'WAIVED',
      due_date: new Date('2020-01-01'),
      voucher_heads: [head(fee({ status: 'WAIVED' }), { waived: true })],
    });
    const { service, tx } = build(v);

    await service.unwaiveVoucher(77, 'admin');

    expect(tx.vouchers.update.mock.calls[0][0].data.status).toBe('OVERDUE');
  });
});

describe('guards around a WAIVED voucher', () => {
  it('forceRemove refuses a WAIVED voucher', async () => {
    const { service, prisma } = build(voucherRow({ status: 'WAIVED' }));
    await expect(service.forceRemove(77, 'admin')).rejects.toThrow(/Un-waive/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reversing a deposit that paid part of a now-waived voucher is refused', async () => {
    const { service, prisma } = build(voucherRow());
    prisma.deposits = {
      findUnique: jest.fn().mockResolvedValue({
        id: 5,
        student_id: 500,
        deposit_allocations: [],
        students: { campus_id: 1, class_id: 4, section_id: 1, classes: { segment_id: 1 } },
      }),
      findFirst: jest.fn().mockResolvedValue({ id: 5 }),
    };
    prisma.deposit_allocations.findFirst.mockResolvedValue({ voucher_id: 77 });

    await expect(service.reverseDeposit(5, 'admin')).rejects.toThrow(/Un-waive that voucher/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('Meezan never collects on a waived voucher', () => {
  const env = { ...process.env };
  beforeAll(() => {
    process.env.MEEZAN_SERVICE_USER_ID = 'u';
    process.env.MEEZAN_SERVICE_PASSWORD = 'p';
  });
  afterAll(() => {
    process.env = env;
  });

  const meezan = (status: string) => {
    const prisma: any = {
      vouchers: { findFirst: jest.fn().mockResolvedValue({ ...voucherRow({ status }), voucher_arrear_surcharges: [] }) },
      $transaction: jest.fn(),
    };
    return { svc: new MeezanService(prisma, {} as any, {} as any), prisma };
  };

  it('bill inquiry reports a WAIVED voucher as not payable', async () => {
    const { svc } = meezan('WAIVED');
    const res: any = await svc.handleBillInquiry({ ServiceUserId: 'u', UserPassword: 'p', VoucherNumber: '10260000077' } as any);
    expect(res.ResponseCode).toBe('093');
  });

  it('bill payment on a WAIVED or VOID voucher books nothing', async () => {
    for (const status of ['WAIVED', 'VOID']) {
      const { svc, prisma } = meezan(status);
      const res: any = await svc.handleBillPayment({
        ServiceUserId: 'u',
        UserPassword: 'p',
        VoucherNumber: '10260000077',
        TransDate: '20260915',
        TransAmount: '10000',
        Status: 'C',
      } as any);
      expect(res.ResponseCode).toBe('093');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
  });
});
