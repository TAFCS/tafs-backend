import { BadRequestException } from '@nestjs/common';
import {
    actorNameOf,
    actorOf,
    assertWholeRupees,
    normalizeEcAcademicYear,
    normalizeEcMonths,
    normalizeEcName,
    toIntArray,
    toUpperStringArray,
} from './ec-common.util';

describe('EC common helpers (TAFSD-605)', () => {
    describe('normalizeEcAcademicYear', () => {
        it('keeps the long form and widens the short one', () => {
            expect(normalizeEcAcademicYear('2026-2027')).toBe('2026-2027');
            expect(normalizeEcAcademicYear('2026-27')).toBe('2026-2027');
            expect(normalizeEcAcademicYear(' 2026 - 27 ')).toBe('2026-2027');
            expect(normalizeEcAcademicYear('2099-00')).toBe('2099-2100');
        });

        it('refuses anything that is not one year long', () => {
            expect(() => normalizeEcAcademicYear('2026-2028')).toThrow(BadRequestException);
            expect(() => normalizeEcAcademicYear('2026')).toThrow(BadRequestException);
            expect(() => normalizeEcAcademicYear('')).toThrow(BadRequestException);
            expect(() => normalizeEcAcademicYear(undefined)).toThrow(BadRequestException);
        });
    });

    describe('normalizeEcMonths', () => {
        it('drops duplicates and orders by the school year (Aug first)', () => {
            expect(normalizeEcMonths([1, 8, 12, 8, 7])).toEqual([8, 12, 1, 7]);
            expect(normalizeEcMonths([11])).toEqual([11]);
        });

        it('refuses a month outside 1-12', () => {
            expect(() => normalizeEcMonths([0])).toThrow(BadRequestException);
            expect(() => normalizeEcMonths([13])).toThrow(BadRequestException);
            expect(() => normalizeEcMonths([2.5])).toThrow(BadRequestException);
        });
    });

    it('stores head names trimmed, single-spaced and upper-cased', () => {
        expect(normalizeEcName('  scouts   registration ')).toBe('SCOUTS REGISTRATION');
    });

    it('accepts only whole rupees', () => {
        expect(assertWholeRupees(1500)).toBe(1500);
        expect(() => assertWholeRupees(1500.5)).toThrow(BadRequestException);
        expect(() => assertWholeRupees(Number.NaN)).toThrow(BadRequestException);
    });

    it('reads repeated or comma-joined query params as arrays', () => {
        expect(toIntArray({ value: '1,2' })).toEqual([1, 2]);
        expect(toIntArray({ value: ['3', '4,5'] })).toEqual([3, 4, 5]);
        expect(toIntArray({ value: '' })).toBeUndefined();
        expect(toUpperStringArray({ value: 'monthly,one_time' })).toEqual(['MONTHLY', 'ONE_TIME']);
    });

    it('names the actor for audit rows and documents', () => {
        expect(actorOf({ username: 'clerk', sub: 'u1' })).toBe('clerk');
        expect(actorOf(undefined)).toBe('system');
        expect(actorNameOf({ fullName: 'Ayesha Khan', username: 'clerk', sub: 'u1' })).toBe('Ayesha Khan');
    });
});
