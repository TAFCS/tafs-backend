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

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

/** "DECEMBER 2026" for a 'YYYY-MM-DD' date. */
export function monthLabel(isoDate: string): string {
    const [y, m] = isoDate.slice(0, 10).split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
}

/** "1 Dec 2026" for a 'YYYY-MM-DD' date. */
export function feeDateLabel(isoDate: string): string {
    const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
    return `${d} ${MONTHS[m - 1].slice(0, 1)}${MONTHS[m - 1].slice(1, 3).toLowerCase()} ${y}`;
}

/** What is still owed for one fee date. */
export interface MonthOwed {
    fee_date: string;
    /** On a voucher the family can pay. */
    billed: number;
    /** Never put on a voucher (head status NOT_ISSUED): the school has to bill it first. */
    not_billed: number;
}

export interface DuesThrough {
    /** Unpaid fee heads (paid, discount and waived rows skipped) dated on or before the fee date. */
    heads_outstanding: number;
    /** The part of heads_outstanding on heads never put on a voucher. */
    not_billed_outstanding: number;
    /** Unpaid, unwaived arrear surcharges on live vouchers dated on or before the fee date. */
    surcharge_outstanding: number;
    head_count: number;
    /** Earliest fee_date among the unpaid heads, 'YYYY-MM-DD'. */
    oldest_fee_date: string | null;
    /** Oldest first. */
    months: MonthOwed[];
}

export const NO_DUES: DuesThrough = {
    heads_outstanding: 0,
    not_billed_outstanding: 0,
    surcharge_outstanding: 0,
    head_count: 0,
    oldest_fee_date: null,
    months: [],
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function totalOwed(d: DuesThrough): number {
    return round2(d.heads_outstanding + d.surcharge_outstanding);
}

/** What the family could pay today: billed heads plus surcharges. */
export function billedOwed(d: DuesThrough): number {
    return round2(d.heads_outstanding - d.not_billed_outstanding + d.surcharge_outstanding);
}

/** Cleared means nothing at all is owed through the fee date, billed or not. */
export function isCleared(d: DuesThrough): boolean {
    return totalOwed(d) <= 0;
}

/**
 * ISSUED: holds a document (whatever they owe now).
 * CLEARED: owes nothing through the fee date.
 * BLOCKED: owes on a voucher, or a surcharge. The family has to pay.
 * NOT_BILLED: owes only on heads never put on a voucher. Still blocked, but the
 * school has to generate the voucher before the family can pay.
 */
export type RosterState = 'ISSUED' | 'CLEARED' | 'NOT_BILLED' | 'BLOCKED';
export const ROSTER_STATES: RosterState[] = ['CLEARED', 'NOT_BILLED', 'BLOCKED', 'ISSUED'];

export function rosterState(hasDocument: boolean, dues: DuesThrough): RosterState {
    if (hasDocument) return 'ISSUED';
    if (isCleared(dues)) return 'CLEARED';
    return billedOwed(dues) > 0 ? 'BLOCKED' : 'NOT_BILLED';
}

/** A student's own fee date wins over the schedule's. */
export function effectiveFeeDate(scheduleFeeDate: string, own: string | null | undefined): string {
    return (own ?? scheduleFeeDate).slice(0, 10);
}

/** "0007" */
export function formatSerial(n: number): string {
    return String(n).padStart(4, '0');
}

/** True when documents may be issued on `today` ('YYYY-MM-DD'). */
export function issueWindowOpen(issueFrom: string | null, today: string): boolean {
    return !issueFrom || issueFrom.slice(0, 10) <= today.slice(0, 10);
}
