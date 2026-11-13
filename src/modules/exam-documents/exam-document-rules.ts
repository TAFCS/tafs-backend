import { CLASS_BAND_IDS } from '../../common/class-band-ids';

/**
 * TAFSD-510: the rules behind admit cards and statements of entry. Pure, so the
 * service and the specs share one definition.
 */

export type ExamDocType = 'ADMIT_CARD' | 'STATEMENT_OF_ENTRY';
export type ExamScheduleStatus = 'DRAFT' | 'PUBLISHED';
export const EXAM_SCHEDULE_STATUSES: ExamScheduleStatus[] = ['DRAFT', 'PUBLISHED'];

/** VI, VII, VIII, IX, X. The same split the leaving certificate uses for TAFSS vs TAFSAL. */
const SECONDARY_CLASS_IDS = new Set<number>(CLASS_BAND_IDS.VI_X);

export function isSecondaryClass(classId: number): boolean {
    return SECONDARY_CLASS_IDS.has(classId);
}

/** VI–X get an admit card; every other class gets a statement of entry. */
export function docTypeForClass(classId: number): ExamDocType {
    return isSecondaryClass(classId) ? 'ADMIT_CARD' : 'STATEMENT_OF_ENTRY';
}

export const DOC_TYPE_LABEL: Record<ExamDocType, string> = {
    ADMIT_CARD: 'Admit card',
    STATEMENT_OF_ENTRY: 'Statement of entry',
};

/** 'YYYY-MM-DD' of the last day of a month (month 1–12). */
export function endOfMonth(year: number, month: number): string {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/** "DECEMBER 2026" for a 'YYYY-MM-DD' date. */
export function monthLabel(isoDate: string): string {
    const [y, m] = isoDate.slice(0, 10).split('-').map(Number);
    const names = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
    return `${names[m - 1]} ${y}`;
}

export interface DuesThrough {
    /** Unpaid fee heads (paid, discount and waived rows skipped) dated on or before the cutoff. */
    heads_outstanding: number;
    /** Unpaid, unwaived arrear surcharges on live vouchers dated on or before the cutoff. */
    surcharge_outstanding: number;
    head_count: number;
    /** Earliest fee_date among the unpaid heads, 'YYYY-MM-DD'. */
    oldest_fee_date: string | null;
}

export const NO_DUES: DuesThrough = { heads_outstanding: 0, surcharge_outstanding: 0, head_count: 0, oldest_fee_date: null };

export function totalOwed(d: DuesThrough): number {
    return Math.round((d.heads_outstanding + d.surcharge_outstanding) * 100) / 100;
}

/** Cleared means nothing at all is owed through the cutoff. */
export function isCleared(d: DuesThrough): boolean {
    return totalOwed(d) <= 0;
}

export type RosterState = 'ISSUED' | 'CLEARED' | 'BLOCKED';

/** A student who already holds a document stays ISSUED whatever they owe now. */
export function rosterState(hasDocument: boolean, dues: DuesThrough): RosterState {
    if (hasDocument) return 'ISSUED';
    return isCleared(dues) ? 'CLEARED' : 'BLOCKED';
}

/** "0007" */
export function formatSerial(n: number): string {
    return String(n).padStart(4, '0');
}

/** True when documents may be issued on `today` ('YYYY-MM-DD'). */
export function issueWindowOpen(issueFrom: string | null, today: string): boolean {
    return !issueFrom || issueFrom.slice(0, 10) <= today.slice(0, 10);
}
