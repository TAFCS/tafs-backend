import { BadRequestException } from '@nestjs/common';
import { calendarYearOf } from '../../common/utils/academic-labels';
import { termStartMonthForClass } from '../../common/utils/class-terms.util';

/**
 * TAFSD-605: dates for extracurricular fees. Every EC date is a Pakistan
 * calendar date stored as a DATE (midnight UTC of that day).
 */

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Today's date in Pakistan, YYYY-MM-DD. */
export function todayPktKey(now = new Date()): string {
    return new Date(now.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Today in Pakistan as a DATE value (midnight UTC of the PKT date). */
export function todayPktDate(now = new Date()): Date {
    return new Date(`${todayPktKey(now)}T00:00:00.000Z`);
}

/** A DATE column (or an ISO string) as YYYY-MM-DD. */
export function dateKey(d: Date | string): string {
    return (typeof d === 'string' ? new Date(d) : d).toISOString().slice(0, 10);
}

/** YYYY-MM-DD from a request, as a DATE value. */
export function parseDateKey(value: string, label: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) throw new BadRequestException(`${label} must be a date (YYYY-MM-DD)`);
    const d = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()) || dateKey(d) !== value) throw new BadRequestException(`${label} is not a real date`);
    return d;
}

/** A DATE value `days` later. */
export function addDays(d: Date, days: number): Date {
    return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The 1st of the calendar month a charge for `month` of `academicYear` falls
 * in, for a student of `classId`: an Aug-Jul class and an Apr-Mar class put
 * "March of 2026-2027" in different calendar years.
 */
export function ecPeriodOf(
    month: number,
    academicYear: string,
    classId: number | null | undefined,
    classTerms: ReadonlyMap<number, number>,
): Date {
    const year = calendarYearOf(month, academicYear, { termStartMonth: termStartMonthForClass(classId, classTerms) });
    if (year == null) throw new BadRequestException(`Can't place month ${month} in ${academicYear}`);
    return new Date(Date.UTC(year, month - 1, 1));
}

/** "SEP 26" for a charge period. */
export function ecPeriodLabel(period: Date | string): string {
    const d = typeof period === 'string' ? new Date(period) : period;
    return `${MONTH_ABBR[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(-2)}`;
}
