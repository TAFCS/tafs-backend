const PDF_MONTHS = ['August','September','October','November','December','January','February','March','April','May','June','July'];
const PDF_MONTH_TO_NUM: Record<string, number> = { August:8,September:9,October:10,November:11,December:12,January:1,February:2,March:3,April:4,May:5,June:6,July:7 };

const SPECIAL_CLASS_IDS = [15, 16, 17, 18, 19];

export function isSpecial(classId?: number): boolean {
    return !!classId && SPECIAL_CLASS_IDS.includes(Number(classId));
}

export function deriveAcademicYear(dateStr: string, classId?: number): string {
    const d = new Date(dateStr);
    const m = d.getUTCMonth() + 1;
    const y = d.getUTCFullYear();
    const cutoff = isSpecial(classId) ? 4 : 8;
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
        classId?: number;
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
        return deriveAcademicYear(dateStr, fallback.classId);
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
        classId?: number;
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
 * Special classes (IDs 15-19) use an April-March year; all others use August-July.
 */
export function getMonthYearLabel(m: number, academicYear: string, classId?: number): string {
    const monthName = PDF_MONTHS.find((_, i) => PDF_MONTH_TO_NUM[PDF_MONTHS[i]] === m) || '';
    const parts = academicYear.split('-').map(y => y.trim());
    const cutoff = isSpecial(classId) ? 4 : 8;
    const year = m >= cutoff ? parts[0] : (parts[1] || parts[0]);
    return `${monthName.slice(0, 3)} ${year.slice(-2)}`;
}

/**
 * Returns a full month+year label, e.g. "APRIL 2026".
 * Same academic-year resolution as getMonthYearLabel, but unabbreviated —
 * used for installment row wording on challans.
 */
export function getFullMonthYearLabel(m: number, academicYear: string, classId?: number): string {
    const monthName = PDF_MONTHS.find((_, i) => PDF_MONTH_TO_NUM[PDF_MONTHS[i]] === m) || '';
    const parts = academicYear.split('-').map(y => y.trim());
    const cutoff = isSpecial(classId) ? 4 : 8;
    const year = m >= cutoff ? parts[0] : (parts[1] || parts[0]);
    return `${monthName.toUpperCase()} ${year}`;
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
    classId?: number,
): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const base = `${feeTypeDesc} INSTALLMENTS PLAN - ${pad(seqNum)} OF ${pad(total)}`;
    if (month == null || !academicYear) return base;
    return `${base} - ${getFullMonthYearLabel(month, academicYear, classId)}`;
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
        } | null;
    }> | null | undefined,
    fallback: {
        month?: number | null;
        feeDate?: Date | string | null;
        classId?: number | null;
    } = {},
): string {
    const classId = fallback.classId ?? undefined;

    const billed = (voucherHeads ?? [])
        .map((h) => {
            const sf = h?.student_fees;
            if (!sf || sf.target_month == null) return null;
            // Mirrors the per-head resolution in prepareVoucherPdfData: special
            // classes with no stored year derive it from the fee's own date.
            const academicYear =
                sf.academic_year ||
                (isSpecial(classId) && sf.fee_date
                    ? deriveAcademicYear(new Date(sf.fee_date).toISOString(), classId)
                    : '');
            return { month: sf.target_month, academicYear };
        })
        .filter((x): x is { month: number; academicYear: string } => x !== null);

    if (billed.length > 0) return getConsolidatedMonthsLabel(billed, classId);
    if (fallback.month) return CALENDAR_MONTHS[fallback.month - 1] ?? 'N/A';
    if (fallback.feeDate) {
        return new Date(fallback.feeDate).toLocaleString('default', { month: 'long' });
    }
    return 'N/A';
}

/**
 * Collapses a list of month+academicYear items into a human-readable label
 * that consolidates consecutive months into ranges, e.g. "AUG 25 - OCT 25".
 */
export function getConsolidatedMonthsLabel(
    items: { month: number; academicYear: string }[],
    classId?: number,
): string {
    if (!items || items.length === 0) return '';

    const getSeq = (month: number, ay: string) => {
        const startYear = parseInt(ay.split('-')[0]) || 0;
        const cutoff = isSpecial(classId) ? 4 : 8;
        const rel = month >= cutoff ? month - cutoff : month + (12 - cutoff);
        return startYear * 12 + rel;
    };

    const uniqueMonths = Array.from(
        new Set(items.map(f => JSON.stringify({ m: f.month, ay: f.academicYear }))),
    )
        .map(s => JSON.parse(s) as { m: number; ay: string })
        .sort((a, b) => getSeq(a.m, a.ay) - getSeq(b.m, b.ay));

    const ranges: { m: number; ay: string }[][] = [];
    let current: { m: number; ay: string }[] = [];

    uniqueMonths.forEach((item, idx) => {
        if (idx === 0) {
            current.push(item);
        } else {
            const prev = uniqueMonths[idx - 1];
            if (getSeq(item.m, item.ay) === getSeq(prev.m, prev.ay) + 1) {
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
            const first = getMonthYearLabel(range[0].m, range[0].ay, classId).toUpperCase();
            if (range.length === 1) return first;
            const last = getMonthYearLabel(range[range.length - 1].m, range[range.length - 1].ay, classId).toUpperCase();
            return `${first} - ${last}`;
        })
        .join(', ');
}
