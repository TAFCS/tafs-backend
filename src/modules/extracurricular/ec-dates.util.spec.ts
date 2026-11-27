import { BadRequestException } from '@nestjs/common';
import { addDays, dateKey, ecPeriodLabel, ecPeriodOf, parseDateKey, todayPktDate, todayPktKey } from './ec-dates.util';
import { chargeLockReason } from './charges/ec-charges.service';

describe('EC dates (TAFSD-605)', () => {
    const classTerms = new Map<number, number>([
        [10, 8], // Aug-Jul
        [11, 4], // Apr-Mar
    ]);

    it('places a month in the right calendar year for each term system', () => {
        expect(dateKey(ecPeriodOf(9, '2026-2027', 10, classTerms))).toBe('2026-09-01');
        expect(dateKey(ecPeriodOf(3, '2026-2027', 10, classTerms))).toBe('2027-03-01');
        expect(dateKey(ecPeriodOf(5, '2026-2027', 11, classTerms))).toBe('2026-05-01');
        expect(dateKey(ecPeriodOf(3, '2026-2027', 11, classTerms))).toBe('2027-03-01');
        // Unknown class: Aug-Jul, like the column default.
        expect(dateKey(ecPeriodOf(7, '2026-2027', null, classTerms))).toBe('2027-07-01');
    });

    it('labels a period the way the challan prints it', () => {
        expect(ecPeriodLabel(new Date('2026-09-01T00:00:00Z'))).toBe('SEP 26');
        expect(ecPeriodLabel('2027-01-01')).toBe('JAN 27');
    });

    it('takes today in Pakistan, not UTC', () => {
        // 20:30 UTC on 30 Nov is already 1 Dec in Pakistan (UTC+5).
        expect(todayPktKey(new Date('2026-11-30T20:30:00Z'))).toBe('2026-12-01');
        expect(todayPktKey(new Date('2026-11-30T18:59:00Z'))).toBe('2026-11-30');
        expect(dateKey(todayPktDate(new Date('2026-11-30T20:30:00Z')))).toBe('2026-12-01');
    });

    it('parses request dates strictly', () => {
        expect(dateKey(parseDateKey('2026-12-15', 'Issue date'))).toBe('2026-12-15');
        expect(() => parseDateKey('2026-02-30', 'Issue date')).toThrow(BadRequestException);
        expect(() => parseDateKey('15/12/2026', 'Issue date')).toThrow(BadRequestException);
        expect(dateKey(addDays(parseDateKey('2026-12-30', 'x'), 15))).toBe('2027-01-14');
    });
});

describe('EC charge lock (TAFSD-605)', () => {
    const free = { status: 'NOT_ISSUED', amount_paid: 0, waived_amount: 0, current_voucher_id: null };

    it('leaves a charge that is not on a voucher free to change', () => {
        expect(chargeLockReason(free)).toBeNull();
    });

    it('locks a charge on a voucher, paid in any part, or waived', () => {
        expect(chargeLockReason({ ...free, status: 'ISSUED', current_voucher_id: 5 })).toBe('ON_VOUCHER');
        expect(chargeLockReason({ ...free, status: 'PARTIALLY_PAID', amount_paid: 100, current_voucher_id: 5 })).toBe('PAID');
        expect(chargeLockReason({ ...free, status: 'PAID', amount_paid: 1000, current_voucher_id: 5 })).toBe('PAID');
        expect(chargeLockReason({ ...free, status: 'WAIVED', waived_amount: 1000, current_voucher_id: 5 })).toBe('WAIVED');
        // A stray current voucher alone is enough.
        expect(chargeLockReason({ ...free, current_voucher_id: 9 })).toBe('ON_VOUCHER');
    });
});
