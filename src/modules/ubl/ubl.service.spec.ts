import { UblService } from './ubl.service';
import {
    ccFromUblConsumerNumber,
    isUblBank,
    isUbl1BillConsumerNumber,
    ubl1BillCharge,
    ubl1BillConsumerNumber,
    ublCc,
    voucherNumberFor,
} from '../../utils/ubl.util';

describe('ubl.util', () => {
    const OLD = process.env.UBL_1BILL_PREFIX;
    afterEach(() => { process.env.UBL_1BILL_PREFIX = OLD; });

    it('recognises UBL bank names only', () => {
        expect(isUblBank('UBL')).toBe(true);
        expect(isUblBank('United Bank Limited')).toBe(true);
        expect(isUblBank('Meezan Bank')).toBe(false);
        expect(isUblBank(null)).toBe(false);
    });

    it('numbers UBL vouchers by plain serial and keeps Meezan MMYY+id', () => {
        expect(voucherNumberFor(12461, new Date('2026-10-01'), 'UBL')).toBe('12461');
        expect(voucherNumberFor(12461, new Date('2026-10-01'), 'Meezan Bank')).toBe('10260012461');
    });

    it('builds the 15-digit 1Bill number as prefix + 5-digit CC and reads it back', () => {
        process.env.UBL_1BILL_PREFIX = '1234567890';
        expect(ubl1BillConsumerNumber(8088)).toBe('123456789008088');
        expect(ubl1BillConsumerNumber(10001)).toBe('123456789010001');
        expect(ccFromUblConsumerNumber('123456789008088')).toBe(8088);
        expect(ccFromUblConsumerNumber('123456789010001')).toBe(10001);
        expect(ccFromUblConsumerNumber('08088')).toBe(8088);
        expect(ccFromUblConsumerNumber('8088')).toBe(8088);
        expect(ccFromUblConsumerNumber('12345678908088')).toBeNull(); // old 14-digit form
        expect(ccFromUblConsumerNumber('999999999908088')).toBeNull(); // wrong prefix
        expect(ccFromUblConsumerNumber('12a4')).toBeNull();
    });

    it('pads CCs to 5 digits', () => {
        expect(ublCc(8088)).toBe('08088');
        expect(ublCc(10000)).toBe('10000');
    });

    it('charges 1Bill by slab, rounded up to whole rupees', () => {
        expect(ubl1BillCharge(4_000)).toBe(17);
        expect(ubl1BillCharge(8_000)).toBe(21);
        expect(ubl1BillCharge(90_000)).toBe(53);
        expect(ubl1BillCharge(200_000)).toBe(85);
        expect(ubl1BillCharge(500_000)).toBe(169);
        expect(ubl1BillCharge(2_000_000)).toBe(338);
        expect(ubl1BillCharge(4_000_000)).toBe(506);
        expect(ubl1BillCharge(6_000_000)).toBe(675);
    });

    it('picks the slab of bill + charge, so a charge crossing a boundary takes the next slab', () => {
        expect(ubl1BillCharge(99_947)).toBe(53); // 99,947 + 53 = 100,000 exactly
        expect(ubl1BillCharge(99_980)).toBe(85); // 99,980 + 53 > 100,000
        expect(ubl1BillCharge(4_990)).toBe(21); // 4,990 + 17 > 5,000
    });

    it('tells a 15-digit 1Bill number from a CC', () => {
        expect(isUbl1BillConsumerNumber('100000000008088')).toBe(true);
        expect(isUbl1BillConsumerNumber('08088')).toBe(false);
        expect(isUbl1BillConsumerNumber('8088')).toBe(false);
        expect(isUbl1BillConsumerNumber('200000000008088')).toBe(false);
    });

    it('falls back to the placeholder prefix until a real 10-digit one is set', () => {
        process.env.UBL_1BILL_PREFIX = '';
        expect(ubl1BillConsumerNumber(8088)).toBe('100000000008088');
        process.env.UBL_1BILL_PREFIX = '123';
        expect(ubl1BillConsumerNumber(8088)).toBe('100000000008088');
    });
});

describe('UblService', () => {
    const DUE = new Date('2026-10-10T00:00:00Z');
    const voucher = (over: Record<string, unknown> = {}) => ({
        id: 500,
        voucher_number: '500',
        status: 'UNPAID',
        issue_date: new Date('2026-10-01T00:00:00Z'),
        due_date: DUE,
        validity_date: new Date('2099-12-31T00:00:00Z'),
        late_fee_charge: true,
        total_payable_before_due: 90000,
        total_payable_after_due: 91000,
        late_fee_deposited: 0,
        head_balance: '90000',
        surcharge_balance: '0',
        total_discount_unapplied: '0',
        months_label: 'OCT 26',
        voucher_heads: [{ id: 9, balance: '90000', student_fees: { is_discount: false, status: 'ISSUED' } }],
        voucher_arrear_surcharges: [],
        ...over,
    });

    const build = (v: any = voucher(), existingDeposit: any = null) => {
        const prisma: any = {
            students: { findUnique: jest.fn().mockResolvedValue({ cc: 8088, full_name: 'TEST', gr_number: '1', campuses: null, classes: null }) },
            vouchers: { findFirst: jest.fn().mockResolvedValue({ id: v.id }) },
            deposits: {
                findFirst: jest.fn()
                    .mockResolvedValueOnce(existingDeposit)
                    .mockResolvedValue({ id: 77 }),
                update: jest.fn().mockResolvedValue({}),
            },
        };
        const vouchers: any = { findOne: jest.fn().mockResolvedValue(v), recordDeposit: jest.fn().mockResolvedValue({}) };
        const audit: any = { log: jest.fn().mockResolvedValue(undefined) };
        return { svc: new UblService(prisma, audit, vouchers), prisma, vouchers };
    };

    beforeAll(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-05T06:00:00Z')));
    afterAll(() => jest.useRealTimers());

    it('quotes a 1Bill number the bill + slab charge and a CC the plain amount', async () => {
        const { svc } = build();
        const onebill: any = await svc.billInquiry({ consumer_number: '100000000008088' });
        const cc: any = await svc.billInquiry({ consumer_number: '8088' });
        expect(onebill.response_code).toBe('00');
        expect(onebill.cc).toBe('08088');
        expect(onebill.amount_payable).toBe(90053);
        expect(onebill.amount_after_due_date).toBe(91053);
        expect(onebill.channel_fee).toBe(53);
        expect(cc.amount_payable).toBe(90000);
        expect(cc.amount_after_due_date).toBe(91000);
        expect(cc.channel_fee).toBe(0);
    });

    it('quotes the after-due amount (+1000) once the due date has passed', async () => {
        jest.setSystemTime(new Date('2026-10-12T06:00:00Z'));
        const { svc } = build();
        const res: any = await svc.billInquiry({ consumer_number: '8088' });
        expect(res.amount_payable).toBe(91000);
        jest.setSystemTime(new Date('2026-10-05T06:00:00Z'));
    });

    it('presents the most recent payable voucher when two are active', async () => {
        const { svc, prisma } = build();
        prisma.vouchers.findFirst = jest.fn().mockResolvedValueOnce({ id: 500 });
        await svc.billInquiry({ consumer_number: '8088' });
        const where = prisma.vouchers.findFirst.mock.calls[0][0].where;
        expect(where.status).toEqual({ in: ['UNPAID', 'OVERDUE', 'PARTIALLY_PAID'] });
        expect(prisma.vouchers.findFirst.mock.calls[0][0].orderBy).toEqual({ id: 'desc' });
    });

    it('rejects a paid voucher', async () => {
        const { svc } = build(voucher({ status: 'PAID' }));
        const res: any = await svc.billInquiry({ consumer_number: '8088' });
        expect(res.response_code).toBe('03');
    });

    const pay = (over: Record<string, unknown> = {}) => ({
        consumer_number: '100000000008088',
        channel: 'ONEBILL' as const,
        payment_method: 'ACCOUNT_TRANSFER' as const,
        amount: 90053,
        transaction_id: 'T1',
        transaction_datetime: '2026-10-05T11:00:00+05:00',
        ...over,
    });

    it('books a 1Bill payment for the voucher amount only', async () => {
        const { svc, vouchers, prisma } = build();
        const res: any = await svc.billPayment(pay());
        expect(res.response_code).toBe('00');
        expect(res.amount_booked).toBe(90000);
        expect(res.channel_fee).toBe(53);
        const [, dto] = vouchers.recordDeposit.mock.calls[0];
        expect(dto.amount).toBe(90000);
        expect(dto.distributions).toEqual({ '9': 90000 });
        expect(dto.payment_method).toBe('ubl');
        expect(prisma.deposits.update.mock.calls[0][0].data.remarks).toContain('1Bill fee PKR 53');
    });

    it('books the late fee on an overdue payment', async () => {
        const { svc, vouchers } = build();
        const res: any = await svc.billPayment(pay({ consumer_number: '8088', channel: 'OTC', payment_method: 'CASH', amount: 91000, transaction_datetime: '2026-10-12T11:00:00+05:00' }));
        expect(res.response_code).toBe('00');
        const [, dto] = vouchers.recordDeposit.mock.calls[0];
        expect(dto.amount).toBe(91000);
        expect(dto.late_fee).toBe(1000);
        expect(dto.distributions).toEqual({ '9': 90000 });
    });

    it('refuses an amount that does not match', async () => {
        const { svc, vouchers } = build();
        const res: any = await svc.billPayment(pay({ amount: 90000 }));
        expect(res.response_code).toBe('06');
        expect(res.amount_payable).toBe(90053);
        expect(vouchers.recordDeposit).not.toHaveBeenCalled();
    });

    it('never books the same transaction twice', async () => {
        const { svc, vouchers } = build(voucher(), { id: 41 });
        const res: any = await svc.billPayment(pay());
        expect(res.response_code).toBe('08');
        expect(res.tafs_receipt_id).toBe('41');
        expect(vouchers.recordDeposit).not.toHaveBeenCalled();
    });

    it('refuses when a newer voucher replaced the one inquired', async () => {
        const { svc } = build();
        const res: any = await svc.billPayment(pay({ voucher_number: '499' }));
        expect(res.response_code).toBe('07');
    });

    it('rejects a channel that does not match the consumer number', async () => {
        const { svc, vouchers } = build();
        expect(((await svc.billPayment(pay({ channel: 'OTC' }))) as any).response_code).toBe('09');
        expect(((await svc.billPayment(pay({ consumer_number: '8088', amount: 90000 }))) as any).response_code).toBe('09');
        expect(((await svc.billPayment(pay({ consumer_number: '8088', channel: undefined, amount: 90000 }))) as any).response_code).toBe('09');
        expect(vouchers.recordDeposit).not.toHaveBeenCalled();
    });

    it('accepts a 1Bill payment without a channel and records it as ONEBILL', async () => {
        const { svc, prisma } = build();
        const res: any = await svc.billPayment(pay({ channel: undefined }));
        expect(res.response_code).toBe('00');
        expect(prisma.deposits.update.mock.calls[0][0].data.remarks).toContain('UBL ONEBILL');
    });

    it('requires an instrument number for cheques', async () => {
        const { svc } = build();
        const res: any = await svc.billPayment(pay({ payment_method: 'CHEQUE' }));
        expect(res.response_code).toBe('09');
    });
});
