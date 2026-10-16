jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
    VoucherPdfService: class {},
}));

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StudentFeesService, feeHeadLockReason } from './student-fees.service';

const SCOPE: any = { isExempt: () => true, whereForStudents: () => ({}) };
const ADMIN: any = { sub: 'u', role: 'SUPER_ADMIN' };

/**
 * TAFSD-362: applying a scholarship must only touch MTF months whose amount is
 * still open. Issued, paid, waived and held-voucher months keep their amount.
 */
describe('applyScholarshipToStudent on a year with committed months', () => {
    const row = (id: number, month: number, extra: Partial<any> = {}) => ({
        id,
        student_id: 4233,
        academic_year: '2026-2027',
        fee_type_id: 1,
        is_discount: false,
        target_month: month,
        fee_date: null,
        status: 'NOT_ISSUED',
        amount_paid: new Prisma.Decimal(0),
        amount_before_discount: new Prisma.Decimal(10000),
        amount_after_discount: null,
        amount: new Prisma.Decimal(10000),
        scholarship_percentage: null,
        voucher_heads: [],
        ...extra,
    });

    const setup = (rows: any[]) => {
        const updates: any[] = [];
        const auditLogs = { log: jest.fn() };
        const prisma: any = {
            students: { findUnique: jest.fn().mockResolvedValue({ cc: 4233 }) },
            scholarship_presets: { findUnique: jest.fn().mockResolvedValue({ id: 2 }), create: jest.fn() },
            student_fees: {
                findMany: jest.fn().mockResolvedValue(rows),
                update: jest.fn((args: any) => {
                    updates.push(args);
                    return args;
                }),
            },
            $transaction: jest.fn(async (ops: any[]) => ops),
        };
        const service = new StudentFeesService(prisma, auditLogs as any, {} as any, SCOPE);
        return { service, updates, auditLogs, prisma };
    };

    const dto = { student_id: 4233, academic_year: '2026-2027', scholarship_percentage: 50, scholarship_type_id: 2 };

    it('changes only open months and reports the rest', async () => {
        const { service, updates, auditLogs } = setup([
            row(1, 8, { status: 'PAID', amount_paid: new Prisma.Decimal(10000), voucher_heads: [{ voucher_id: 11 }] }),
            row(2, 9, { status: 'PARTIALLY_PAID', amount_paid: new Prisma.Decimal(4000), voucher_heads: [{ voucher_id: 12 }] }),
            row(3, 10, { status: 'ISSUED', voucher_heads: [{ voucher_id: 13 }] }),
            row(4, 11, { voucher_heads: [{ voucher_id: 14 }] }), // held voucher, status not yet flipped
            row(5, 12, { status: 'WAIVED' }),
            row(6, 1),
            row(7, 2),
        ]);

        const result = await service.applyScholarshipToStudent(dto, ADMIN);

        expect(updates.map((u) => u.where.id)).toEqual([6, 7]);
        expect(updates[0].data.amount.toString()).toBe('5000');
        expect(result.updated).toBe(2);
        expect(result.skipped.map((s: any) => [s.id, s.reason, s.voucher_id])).toEqual([
            [1, 'paid', 11],
            [2, 'paid', 12],
            [3, 'on a voucher', 13],
            [4, 'on a voucher', 14],
            [5, 'waived', null],
        ]);
        expect(auditLogs.log.mock.calls[0][0].note).toContain('Left unchanged');
    });

    it('refuses when every month is committed, without creating a preset', async () => {
        const { service, updates, prisma } = setup([
            row(1, 8, { status: 'PAID', amount_paid: new Prisma.Decimal(10000), voucher_heads: [{ voucher_id: 11 }] }),
        ]);
        await expect(
            service.applyScholarshipToStudent({ ...dto, scholarship_type_id: undefined, custom_title: 'merit' } as any, ADMIN),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(updates).toHaveLength(0);
        expect(prisma.scholarship_presets.create).not.toHaveBeenCalled();
    });

    it('re-applying a new percentage computes from the stored base, not the reduced amount', async () => {
        const { service, updates } = setup([
            row(6, 1, {
                amount_after_discount: new Prisma.Decimal(10000),
                amount: new Prisma.Decimal(5000),
                scholarship_percentage: new Prisma.Decimal(50),
            }),
        ]);
        await service.applyScholarshipToStudent({ ...dto, scholarship_percentage: 25 }, ADMIN);
        expect(updates[0].data.amount.toString()).toBe('7500');
    });

    it('feeHeadLockReason treats any money against a head as paid', () => {
        expect(feeHeadLockReason({ status: 'NOT_ISSUED', amount_paid: 1, voucher_heads: [] })).toBe('paid');
        expect(feeHeadLockReason({ status: 'NOT_ISSUED', amount_paid: 0, voucher_heads: [] })).toBeNull();
    });
});
