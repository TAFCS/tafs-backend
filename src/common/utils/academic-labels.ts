const PDF_MONTHS = ['August','September','October','November','December','January','February','March','April','May','June','July'];
const PDF_MONTH_TO_NUM: Record<string, number> = { August:8,September:9,October:10,November:11,December:12,January:1,February:2,March:3,April:4,May:5,June:6,July:7 };

const SPECIAL_CLASS_IDS = [15, 16, 17, 18, 19];

function isSpecial(classId?: number): boolean {
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
