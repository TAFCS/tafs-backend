const PDF_MONTHS = ['August','September','October','November','December','January','February','March','April','May','June','July'];
const PDF_MONTH_TO_NUM: Record<string, number> = { August:8,September:9,October:10,November:11,December:12,January:1,February:2,March:3,April:4,May:5,June:6,July:7 };

/** Aug-Jul. The term every class runs on unless it says otherwise. */
export const DEFAULT_TERM_START_MONTH = 8;

/**
 * Legacy fallback for classes whose term we can't look up.
 *
 * These are the Secondary VI-X classes, seeded to term_start_month = 4 by
 * migration 20260510000000_add_term_start_month_and_test_data. Prefer passing
 * `classTerms` (a class_id -> classes.term_start_month map) so the DB column is
 * the authority; this array only covers callers that have no class data loaded.
 * It cannot see Apr-Mar classes created after it was written.
 */
const SPECIAL_CLASS_IDS = [15, 16, 17, 18, 19];

export function isSpecial(classId?: number): boolean {
    return !!classId && SPECIAL_CLASS_IDS.includes(Number(classId));
}

/**
 * Where a term cutoff comes from, in priority order.
 *
 * This is an object rather than a bare number on purpose. Every one of these
 * call sites used to take `classId?: number`, and a cutoff is also a number, so
 * a plain-number parameter would let a stray `voucher.class_id` be silently
 * read as "term starts in month 17". Making it an object turns every missed
 * call site into a compile error.
 */
export interface TermContext {
    /** From student_fees.term_start_month — the term in force when the head was written. Wins. */
    termStartMonth?: number | null;
    /** Fallback: infer from a class. Only correct when the head has never crossed term systems. */
    classId?: number | null;
    /** class_id -> classes.term_start_month. Supply it and the DB column beats SPECIAL_CLASS_IDS. */
    classTerms?: ReadonlyMap<number, number> | null;
}

/** Resolve the month a term starts in (8 = Aug-Jul, 4 = Apr-Mar). */
export function resolveTermStartMonth(term?: TermContext | null): number {
    if (term?.termStartMonth != null) return Number(term.termStartMonth);

    const classId = term?.classId;
    if (classId != null) {
        const fromDb = term?.classTerms?.get(Number(classId));
        if (fromDb != null) return Number(fromDb);
        if (isSpecial(Number(classId))) return 4;
    }

    return DEFAULT_TERM_START_MONTH;
}

/**
 * Build a TermContext for one fee head, preferring the term stamped on the head
 * and falling back to the class it is being viewed through.
 */
export function termOfHead(
    head: { term_start_month?: number | null } | null | undefined,
    fallback?: Omit<TermContext, 'termStartMonth'>,
): TermContext {
    return {
        termStartMonth: head?.term_start_month ?? null,
        classId: fallback?.classId ?? null,
        classTerms: fallback?.classTerms ?? null,
    };
}

/**
 * THE derivation. `(target_month, academic_year)` alone is ambiguous — "June of
 * 2025-2026" is June 2026 on an Aug-Jul term and June 2025 on an Apr-Mar one —
 * and this is the only place that ambiguity gets resolved.
 */
export function calendarYearOf(month: number, academicYear: string, term?: TermContext): number | null {
    const parts = (academicYear || '').split('-').map(y => y.trim());
    const startYear = parseInt(parts[0], 10);
    if (!Number.isFinite(startYear)) return null;

    const cutoff = resolveTermStartMonth(term);
    return month >= cutoff ? startYear : startYear + 1;
}

/**
 * A totally-ordered index for sorting heads by when they fall in real time.
 *
 * Deliberately calendar-absolute rather than term-relative: a list that mixes
 * heads from two term systems (a student moved between them) has no consistent
 * term-relative ordering, because "slot 0" means a different month for each.
 * Use `termRelativeSlot` only where the position *within* a term is the point.
 */
export function monthAbsoluteIndex(month: number, academicYear: string, term?: TermContext): number | null {
    const year = calendarYearOf(month, academicYear, term);
    if (year == null) return null;
    return year * 12 + month;
}

/** Position of a month within its own term: 0 = first month of the term. */
export function termRelativeSlot(month: number, term?: TermContext): number {
    const cutoff = resolveTermStartMonth(term);
    return month >= cutoff ? month - cutoff : month + (12 - cutoff);
}

export function deriveAcademicYear(dateStr: string, term?: TermContext): string {
    const d = new Date(dateStr);
    const m = d.getUTCMonth() + 1;
    const y = d.getUTCFullYear();
    const cutoff = resolveTermStartMonth(term);
    const startYear = m >= cutoff ? y : y - 1;
    return `${startYear}-${startYear + 1}`;
}

/**
 * Resolve the academic year printed on a voucher challan header.
 *
 * Prefer a single shared academic_year from the fee heads being billed so the
 * header matches month labels (e.g. AUG 25 → 2025-2026). When heads span
 * multiple sessions or have no year, fall back to fee_date derivation, then an
 * explicit stored/client value.
 */
export function resolveVoucherAcademicYear(
    feeAcademicYears: Array<string | null | undefined>,
    fallback: {
        feeDate?: string | Date | null;
        term?: TermContext;
        stored?: string | null;
    } = {},
): string {
    const years = [
        ...new Set(
            feeAcademicYears
                .map((y) => (y ?? '').trim())
                .filter((y) => y.length > 0),
        ),
    ];
    if (years.length === 1) return years[0];

    if (fallback.feeDate != null && fallback.feeDate !== '') {
        const dateStr =
            fallback.feeDate instanceof Date
                ? fallback.feeDate.toISOString()
                : String(fallback.feeDate);
        return deriveAcademicYear(dateStr, fallback.term);
    }

    if (fallback.stored?.trim()) return fallback.stored.trim();
    return 'N/A';
}

/**
 * Resolve the academic term(s) *displayed* on the voucher challan header.
 *
 * Same single-shared-year fast path as resolveVoucherAcademicYear, but when
 * the billed fee heads span multiple distinct sessions (e.g. an arrear head
 * tagged 2025-2026 alongside a current head tagged 2026-2027), the header
 * lists every distinct year involved — chronologically, comma-separated —
 * instead of collapsing to a single derived/fallback year. This is purely a
 * display label: the persisted vouchers.academic_year column (VarChar(10),
 * and used elsewhere for single-year comparisons) still uses
 * resolveVoucherAcademicYear and must never receive this joined string.
 */
export function resolveVoucherAcademicYearLabel(
    feeAcademicYears: Array<string | null | undefined>,
    fallback: {
        feeDate?: string | Date | null;
        term?: TermContext;
        stored?: string | null;
    } = {},
): string {
    const years = [
        ...new Set(
            feeAcademicYears
                .map((y) => (y ?? '').trim())
                .filter((y) => y.length > 0),
        ),
    ];

    if (years.length > 1) {
        return years
            .sort((a, b) => (parseInt(a.split('-')[0], 10) || 0) - (parseInt(b.split('-')[0], 10) || 0))
            .join(', ');
    }

    return resolveVoucherAcademicYear(feeAcademicYears, fallback);
}

/**
 * Returns a short month+year label for a PDF head, e.g. "Sep 25" or "Jan 26".
 */
export function getMonthYearLabel(m: number, academicYear: string, term?: TermContext): string {
    const monthName = PDF_MONTHS.find((_, i) => PDF_MONTH_TO_NUM[PDF_MONTHS[i]] === m) || '';
    const parts = (academicYear || '').split('-').map(y => y.trim());
    const year = calendarYearOf(m, academicYear, term);
    const yearStr = year != null ? String(year) : (parts[0] || '');
    return `${monthName.slice(0, 3)} ${yearStr.slice(-2)}`;
}

/**
 * Returns a full month+year label, e.g. "APRIL 2026".
 * Same academic-year resolution as getMonthYearLabel, but unabbreviated —
 * used for installment row wording on challans.
 */
export function getFullMonthYearLabel(m: number, academicYear: string, term?: TermContext): string {
    const monthName = PDF_MONTHS.find((_, i) => PDF_MONTH_TO_NUM[PDF_MONTHS[i]] === m) || '';
    const parts = (academicYear || '').split('-').map(y => y.trim());
    const year = calendarYearOf(m, academicYear, term);
    return `${monthName.toUpperCase()} ${year != null ? year : (parts[0] || '')}`;
}

/**
 * Canonical wording for an installment row on a challan, e.g.
 *   "ANNUAL CHARGES INSTALLMENTS PLAN - 01 OF 09 - APRIL 2026"
 *
 * Pass month/academicYear to append the " - <MONTH> <YEAR>" suffix; omit them
 * for contexts that already carry the month in a separate column.
 */
export function getInstallmentLabel(
    feeTypeDesc: string,
    seqNum: number,
    total: number,
    month?: number | null,
    academicYear?: string | null,
    term?: TermContext,
): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const base = `${feeTypeDesc} INSTALLMENTS PLAN - ${pad(seqNum)} OF ${pad(total)}`;
    if (month == null || !academicYear) return base;
    return `${base} - ${getFullMonthYearLabel(month, academicYear, term)}`;
}

const CALENDAR_MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Builds the "FOR MONTH(S) OF" label — the one printed on the challan and shown
 * on the parent app's voucher cards, e.g. "AUG 25 - OCT 25, JAN 26".
 *
 * Months come from the billed fee rows (student_fees.target_month), never from
 * vouchers.month: that column is header metadata picked in the /fee-challan UI
 * at creation time and nothing reconciles it against the heads that land on the
 * voucher, so on a multi-month challan it names at most one of them (and is
 * nullable besides). Falls back to it only when no head carries a month.
 *
 * Takes raw voucher_heads (with student_fees included) so both the PDF pipeline
 * and the API response derive the label from one implementation.
 */
export function buildVoucherMonthsLabel(
    voucherHeads: Array<{
        student_fees?: {
            target_month?: number | null;
            academic_year?: string | null;
            fee_date?: Date | string | null;
            term_start_month?: number | null;
        } | null;
    }> | null | undefined,
    fallback: {
        month?: number | null;
        feeDate?: Date | string | null;
        classId?: number | null;
        classTerms?: ReadonlyMap<number, number> | null;
    } = {},
): string {
    const classFallback = { classId: fallback.classId, classTerms: fallback.classTerms };

    const billed = (voucherHeads ?? [])
        .map((h) => {
            const sf = h?.student_fees;
            if (!sf || sf.target_month == null) return null;
            const term = termOfHead(sf, classFallback);
            // Mirrors the per-head resolution in prepareVoucherPdfData: heads on
            // an Apr-Mar term with no stored year derive it from the fee's own date.
            const academicYear =
                sf.academic_year ||
                (resolveTermStartMonth(term) !== DEFAULT_TERM_START_MONTH && sf.fee_date
                    ? deriveAcademicYear(new Date(sf.fee_date).toISOString(), term)
                    : '');
            return { month: sf.target_month, academicYear, term };
        })
        .filter((x): x is { month: number; academicYear: string; term: TermContext } => x !== null);

    if (billed.length > 0) return getConsolidatedMonthsLabel(billed, classFallback);
    if (fallback.month) return CALENDAR_MONTHS[fallback.month - 1] ?? 'N/A';
    if (fallback.feeDate) {
        return new Date(fallback.feeDate).toLocaleString('default', { month: 'long' });
    }
    return 'N/A';
}

/**
 * Collapses a list of month+academicYear items into a human-readable label
 * that consolidates consecutive months into ranges, e.g. "AUG 25 - OCT 25".
 *
 * Each item may carry its own term; a list spanning a term change is ordered and
 * ranged on calendar time, so a Jun-2026 Cambridge head and a Jul-2026 Secondary
 * head still read as consecutive.
 */
export function getConsolidatedMonthsLabel(
    items: { month: number; academicYear: string; term?: TermContext }[],
    fallbackTerm?: TermContext,
): string {
    if (!items || items.length === 0) return '';

    const termFor = (item: { term?: TermContext }) => item.term ?? fallbackTerm;
    const seqOf = (item: { month: number; academicYear: string; term?: TermContext }) =>
        monthAbsoluteIndex(item.month, item.academicYear, termFor(item)) ?? 0;

    const uniqueMonths = Array.from(
        new Map(
            items.map(f => [`${f.month}|${f.academicYear}`, f]),
        ).values(),
    ).sort((a, b) => seqOf(a) - seqOf(b));

    const ranges: (typeof uniqueMonths)[] = [];
    let current: typeof uniqueMonths = [];

    uniqueMonths.forEach((item, idx) => {
        if (idx === 0) {
            current.push(item);
        } else {
            const prev = uniqueMonths[idx - 1];
            if (seqOf(item) === seqOf(prev) + 1) {
                current.push(item);
            } else {
                ranges.push(current);
                current = [item];
            }
        }
    });
    ranges.push(current);

    return ranges
        .map(range => {
            const first = getMonthYearLabel(range[0].month, range[0].academicYear, termFor(range[0])).toUpperCase();
            if (range.length === 1) return first;
            const lastItem = range[range.length - 1];
            const last = getMonthYearLabel(lastItem.month, lastItem.academicYear, termFor(lastItem)).toUpperCase();
            return `${first} - ${last}`;
        })
        .join(', ');
}
