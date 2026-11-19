import * as ExcelJS from 'exceljs';
import { DuesThrough, billedOwed, feeDateLabel, totalOwed } from './exam-document-rules';

/**
 * TAFSD-543: the report of one Issue run. Every student the run was asked for
 * ends up ISSUED, REPRINTED or SKIPPED; a skipped student carries the reason, in
 * words staff can act on. Pure, so the service and the specs share it.
 */

export type RunOutcome = 'ISSUED' | 'REPRINTED' | 'SKIPPED';

/** Why a student got no document. Codes are stored; reasons are for people. */
export const SKIP_REASONS = {
    NOT_FOUND: 'Not found, or outside your access',
    NOT_ENROLLED: 'Not enrolled',
    OTHER_CAMPUS: 'On another campus',
    CLASS_NOT_ON_SCHEDULE: 'Their class is not on this schedule',
    DUES_NOT_CLEARED: 'Dues not cleared',
    NOT_BILLED: 'Fees never put on a voucher',
    ALREADY_ISSUED: 'Already has a document',
} as const;
export type SkipCode = keyof typeof SKIP_REASONS;

/** What a document was printed without. The document is still issued. */
export const GAP_LABELS = {
    NO_PHOTO: 'No photo on file',
    PHOTO_UNREADABLE: 'Photo could not be loaded',
    NO_FATHER: "No father's name",
    NO_DOB: 'No date of birth',
} as const;
export type GapCode = keyof typeof GAP_LABELS;

export interface RunStudent {
    cc: number;
    gr: string | null;
    name: string;
    class: string | null;
    section: string | null;
    outcome: RunOutcome;
    reason_code: SkipCode | null;
    /** The reason in full, e.g. "Owes Rs 37,990 through 1 Dec 2026 (Oct 2026, Nov 2026)". */
    reason: string | null;
    /** What was owed through the fee date, for DUES_NOT_CLEARED / NOT_BILLED. */
    owed: number | null;
    /** The fee date the student was checked against, 'YYYY-MM-DD'. */
    fee_date: string | null;
    /** '0007' for an issued or reprinted document. */
    serial: string | null;
    gaps: GapCode[];
}

/** Why a student with no document can't get one, from their record. Null when eligible. */
export function eligibilitySkip(
    s: { status: string | null; campus_id: number | null; class_id: number | null } | undefined,
    schedule: { campus_id: number; class_ids: number[] },
): { code: SkipCode; reason: string } | null {
    if (!s) return { code: 'NOT_FOUND', reason: SKIP_REASONS.NOT_FOUND };
    if (s.status !== 'ENROLLED') return { code: 'NOT_ENROLLED', reason: `Not enrolled (${s.status ?? 'no status'})` };
    if (s.campus_id !== schedule.campus_id) return { code: 'OTHER_CAMPUS', reason: SKIP_REASONS.OTHER_CAMPUS };
    if (s.class_id == null || !schedule.class_ids.includes(s.class_id)) {
        return { code: 'CLASS_NOT_ON_SCHEDULE', reason: SKIP_REASONS.CLASS_NOT_ON_SCHEDULE };
    }
    return null;
}

const shortMonth = (isoDate: string) => feeDateLabel(isoDate).replace(/^\d+ /, '');
const rs = (n: number) => `Rs ${n.toLocaleString('en-US')}`;

/**
 * Why dues stop a student, or null when they're cleared. A student who only owes
 * fees never put on a voucher is NOT_BILLED: the school has to bill them first.
 */
export function duesSkip(d: DuesThrough, feeDate: string): { code: SkipCode; reason: string; owed: number } | null {
    const owed = totalOwed(d);
    if (owed <= 0) return null;
    const months = d.months.map((m) => shortMonth(m.fee_date));
    const monthList = months.length ? ` (${months.slice(0, 6).join(', ')}${months.length > 6 ? `, +${months.length - 6} more` : ''})` : '';
    if (billedOwed(d) <= 0) {
        return {
            code: 'NOT_BILLED',
            reason: `Owes ${rs(owed)} through ${feeDateLabel(feeDate)} that was never put on a voucher${monthList}. Generate the voucher first.`,
            owed,
        };
    }
    const notBilled = d.not_billed_outstanding > 0 ? `, ${rs(d.not_billed_outstanding)} of it never billed` : '';
    const surcharge = d.surcharge_outstanding > 0 ? `, incl. ${rs(d.surcharge_outstanding)} surcharge` : '';
    return { code: 'DUES_NOT_CLEARED', reason: `Owes ${rs(owed)} through ${feeDateLabel(feeDate)}${monthList}${notBilled}${surcharge}`, owed };
}

/** What a printed document is missing. */
export function gapsOf(s: { has_photo_on_file: boolean; photo_embedded: boolean; has_father: boolean; has_dob: boolean }): GapCode[] {
    const gaps: GapCode[] = [];
    if (!s.has_photo_on_file) gaps.push('NO_PHOTO');
    else if (!s.photo_embedded) gaps.push('PHOTO_UNREADABLE');
    if (!s.has_father) gaps.push('NO_FATHER');
    if (!s.has_dob) gaps.push('NO_DOB');
    return gaps;
}

/** "Sr. I – A, Sr. I – B" for the classes and sections a run covered. */
export function runLabel(students: { class: string | null; section: string | null }[]): string {
    const counts = new Map<string, number>();
    // A C.C. that matched no student has no class to name; it still counts in the report.
    for (const s of students) {
        if (!s.class) continue;
        const key = s.section ? `${s.class} – ${s.section}` : s.class;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const keys = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const label = keys.length > 6 ? `${keys.slice(0, 6).join(', ')} and ${keys.length - 6} more` : keys.join(', ');
    return label.slice(0, 300) || 'No students';
}

/** Skipped students first (the ones staff need to act on), then by class, section and name. */
export function sortRunStudents(rows: RunStudent[]): RunStudent[] {
    const rank: Record<RunOutcome, number> = { SKIPPED: 0, ISSUED: 1, REPRINTED: 2 };
    return [...rows].sort(
        (a, b) =>
            rank[a.outcome] - rank[b.outcome] ||
            (a.class ?? '').localeCompare(b.class ?? '', 'en', { numeric: true }) ||
            (a.section ?? '').localeCompare(b.section ?? '') ||
            a.name.localeCompare(b.name),
    );
}

export function runCounts(rows: RunStudent[]) {
    return {
        requested: rows.length,
        issued: rows.filter((r) => r.outcome === 'ISSUED').length,
        reprinted: rows.filter((r) => r.outcome === 'REPRINTED').length,
        skipped: rows.filter((r) => r.outcome === 'SKIPPED').length,
        with_gaps: rows.filter((r) => r.outcome !== 'SKIPPED' && r.gaps.length > 0).length,
    };
}

const OUTCOME_LABEL: Record<RunOutcome, string> = { ISSUED: 'Issued', REPRINTED: 'Reprinted', SKIPPED: 'Not generated' };

export interface RunSheetInput {
    scheduleTitle: string;
    academicYear: string;
    campus: string;
    label: string;
    createdBy: string;
    /** Already formatted in Karachi time. */
    createdAt: string;
    students: RunStudent[];
}

/** The run report as an Excel sheet: a header, the counts, then one row per student. */
export async function buildRunWorkbook(input: RunSheetInput): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Report', { views: [{ state: 'frozen', ySplit: 6 }] });
    const c = runCounts(input.students);
    ws.addRow([`${input.scheduleTitle} ${input.academicYear} — ${input.campus}`]).font = { bold: true, size: 13 };
    ws.addRow([`Issue run: ${input.label}`]);
    ws.addRow([`By ${input.createdBy}, ${input.createdAt}`]);
    ws.addRow([
        `Asked for ${c.requested}: ${c.issued} issued, ${c.reprinted} reprinted, ${c.skipped} not generated, ${c.with_gaps} printed with missing details`,
    ]);
    ws.addRow([]);
    const header = ws.addRow(['C.C.', 'G.R.', 'Name', 'Class', 'Section', 'Result', 'Reason', 'Owed (Rs)', 'Fee date', 'Serial', 'Missing on the document']);
    header.font = { bold: true };
    header.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4E4E7' } };
        cell.border = { bottom: { style: 'thin' } };
    });
    for (const r of sortRunStudents(input.students)) {
        const row = ws.addRow([
            r.cc,
            r.gr ?? '',
            r.name,
            r.class ?? '',
            r.section ?? '',
            OUTCOME_LABEL[r.outcome],
            r.reason ?? '',
            r.owed ?? '',
            r.fee_date ? feeDateLabel(r.fee_date) : '',
            r.serial ?? '',
            r.gaps.map((g) => GAP_LABELS[g]).join(', '),
        ]);
        if (r.outcome === 'SKIPPED') row.getCell(6).font = { bold: true, color: { argb: 'FFB91C1C' } };
    }
    ws.getColumn(8).numFmt = '#,##0';
    const widths = [8, 10, 30, 12, 9, 15, 70, 12, 13, 8, 34];
    widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
    ws.getColumn(7).alignment = { wrapText: true, vertical: 'top' };
    return Buffer.from(await wb.xlsx.writeBuffer());
}
