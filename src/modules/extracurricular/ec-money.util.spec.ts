import { BadRequestException } from '@nestjs/common';
import { allocateAuto, deriveChargeStatus, deriveVoucherStatus, formatEcVoucherNumber, remainingOf, validateManual } from './ec-money.util';

describe('EC money rules (TAFSD-605)', () => {
    describe('voucher number', () => {
        it('is EC + MMYY of the issue date + the id padded to 6', () => {
            expect(formatEcVoucherNumber(42, new Date('2026-11-27T00:00:00Z'))).toBe('EC1126000042');
            expect(formatEcVoucherNumber(7, new Date('2027-01-03T00:00:00Z'))).toBe('EC0127000007');
        });

        it('never cuts an id longer than 6 digits', () => {
            expect(formatEcVoucherNumber(1234567, new Date('2026-11-27T00:00:00Z'))).toBe('EC11261234567');
            expect(formatEcVoucherNumber(1234567, new Date('2026-11-27T00:00:00Z'))).toMatch(/^EC\d{10,}$/);
        });
    });

    it('works out what is left, never below zero', () => {
        expect(remainingOf({ amount: 2500, amount_paid: 1000, waived_amount: 0 })).toBe(1500);
        expect(remainingOf({ amount: 2500, amount_paid: 1000, waived_amount: 1500 })).toBe(0);
        expect(remainingOf({ amount: 2500, amount_paid: 3000, waived_amount: 0 })).toBe(0);
    });

    describe('automatic split', () => {
        const lines = [
            { id: 1, remaining: 2500 },
            { id: 2, remaining: 0 },
            { id: 3, remaining: 16000 },
        ];

        it('fills lines in order, each up to what it owes', () => {
            expect([...allocateAuto(lines, 3000)]).toEqual([
                [1, 2500],
                [3, 500],
            ]);
            expect([...allocateAuto(lines, 18500)]).toEqual([
                [1, 2500],
                [3, 16000],
            ]);
        });

        it('refuses more than the balance, zero, negatives and fractions', () => {
            expect(() => allocateAuto(lines, 18501)).toThrow(BadRequestException);
            expect(() => allocateAuto(lines, 0)).toThrow(BadRequestException);
            expect(() => allocateAuto(lines, -5)).toThrow(BadRequestException);
            expect(() => allocateAuto(lines, 10.5)).toThrow(BadRequestException);
        });
    });

    describe('split chosen by hand', () => {
        const lines = [
            { id: 1, remaining: 2500 },
            { id: 3, remaining: 16000 },
        ];

        it('accepts parts that fit their lines and add up', () => {
            expect([...validateManual(lines, [{ line_id: 3, amount: 1000 }, { line_id: 1, amount: 500 }, { line_id: 1, amount: 0 }], 1500)]).toEqual([
                [3, 1000],
                [1, 500],
            ]);
        });

        it('refuses a foreign line, too much on a line, a repeat and a wrong total', () => {
            expect(() => validateManual(lines, [{ line_id: 9, amount: 100 }], 100)).toThrow(/not on this voucher/);
            expect(() => validateManual(lines, [{ line_id: 1, amount: 2600 }], 2600)).toThrow(/more than that line/);
            expect(() => validateManual(lines, [{ line_id: 1, amount: 100 }, { line_id: 1, amount: 100 }], 200)).toThrow(/twice/);
            expect(() => validateManual(lines, [{ line_id: 1, amount: 100 }], 200)).toThrow(/add up/);
        });
    });

    it('derives a charge status from its money', () => {
        const base = { amount: 2500, amount_paid: 0, waived_amount: 0, on_voucher: true };
        expect(deriveChargeStatus({ ...base, on_voucher: false })).toBe('NOT_ISSUED');
        expect(deriveChargeStatus(base)).toBe('ISSUED');
        expect(deriveChargeStatus({ ...base, amount_paid: 100 })).toBe('PARTIALLY_PAID');
        expect(deriveChargeStatus({ ...base, amount_paid: 2500 })).toBe('PAID');
        expect(deriveChargeStatus({ ...base, waived_amount: 2500 })).toBe('WAIVED');
        expect(deriveChargeStatus({ ...base, amount_paid: 1000, waived_amount: 1500 })).toBe('WAIVED');
    });

    it('derives a voucher status from its money (EXPIRED is never stored)', () => {
        expect(deriveVoucherStatus({ total: 23500, paid: 0, waived: 0 })).toBe('UNPAID');
        expect(deriveVoucherStatus({ total: 23500, paid: 5000, waived: 0 })).toBe('PARTIALLY_PAID');
        expect(deriveVoucherStatus({ total: 23500, paid: 23500, waived: 0 })).toBe('PAID');
        expect(deriveVoucherStatus({ total: 23500, paid: 0, waived: 23500 })).toBe('WAIVED');
        // Part-paid, then the rest waived: WAIVED, as on academic vouchers.
        expect(deriveVoucherStatus({ total: 23500, paid: 5000, waived: 18500 })).toBe('WAIVED');
    });
});
