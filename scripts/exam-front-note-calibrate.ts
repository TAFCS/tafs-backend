/**
 * TAFSD-555: measure how much room the front page of an admit card / statement of entry has
 * beyond its paper rows and the box of standard lines, by rendering the school's December 2026
 * schedules with longer and longer front notes until the page spills onto a second sheet.
 * Prints the range for each segment; FRONT_SPARE in ExamDocumentPDF.tsx takes the low ends.
 * No database. Rerun after changing the front page's layout.
 *   npx ts-node --transpile-only scripts/exam-front-note-calibrate.ts
 */
/* eslint-disable */
import {
    FRONT_SPARE,
    FULL_NOTE_SIZE,
    admitNotesHeight,
    entryNotesHeight,
    frontFit,
    paperLines,
    standardFrontNotes,
    tableHeight,
} from '../src/modules/exam-documents/ExamDocumentPDF';
import { buildExamDocPage } from '../src/modules/exam-documents/exam-document-page';
import { pdfPageCount, renderFrontPage } from '../src/modules/exam-documents/exam-front-fit';
import { DEC_2026_SCHEDULES, toUpsertBody } from './data/exam-schedules-dec-2026';

const SETS = [
    { key: 'jr', classId: 4 },
    { key: 'sr', classId: 9 },
    { key: 'o', classId: 14 },
    { key: 'vi-viii', classId: 15 },
    { key: 'ix-x', classId: 18 },
];
/** The paper rows' budget with the standard lines (ROWS_BUDGET; ADMIT_BUDGET less STANDARD_NOTES_H). */
const ROWS = { STATEMENT_OF_ENTRY: 204, ADMIT_CARD: 325 - 42 };

async function main() {
    // Let the note grow without anything shrinking, so only the render decides.
    FRONT_SPARE.entry = FRONT_SPARE.admit = 1000;
    for (const set of SETS) {
        const b: any = toUpsertBody(DEC_2026_SCHEDULES.find((s) => s.key === set.key)!);
        const page = (documentNotes: string[]) =>
            buildExamDocPage({
                schedule: {
                    title: b.title,
                    segmentLine: b.segment_line ?? null,
                    academicYear: b.academic_year,
                    notes: b.notes,
                    documentNotes,
                    // The longest campus footer in production (two lines under the campus name).
                    campusName: 'Gulistan-e-Johar Campus',
                    campusAddress: 'C-61, 62, 63, 64 & 65, Block 13, Gulistan-e-Jauhar, Karachi · Phone (92-21) 3476-5111-13 · Fax (92-21) 3476-5114',
                    campusUan: '111-000-000',
                    papers: b.papers.map((p: any) => ({ ...p, paper_date: new Date(`${p.paper_date}T00:00:00Z`), code: p.code ?? null })),
                },
                classId: set.classId,
                className: 'X',
                sectionName: 'A',
                serialNo: 7,
                issuedAt: new Date('2026-12-09T05:00:00Z'),
                student: { cc: 4137, gr: '6120', fullName: 'Hamza Arif', father: 'Muhammad Arif Siddiqui', dob: new Date('2014-05-22'), gender: 'Male' },
                photo: null,
            });
        const base = page([]);
        const standard = frontFit(base);
        const standardH = entryNotesHeight(standardFrontNotes(base));
        const noteH = (notes: string[]) => (base.docType === 'ADMIT_CARD' ? admitNotesHeight(notes) : entryNotesHeight(notes)) - standardH;
        // Whatever the rows leave of their budget is free too; FRONT_SPARE is what lies beyond it.
        const rowsLeft = ROWS[base.docType] - tableHeight(paperLines(base), standard);
        let fits = NaN;
        let spills = NaN;
        for (let k = 1; k <= 40; k++) {
            const notes = Array<string>(k).fill('NO BAGS ARE ALLOWED.');
            const d = page(notes);
            const f = frontFit(d);
            if (f.size !== standard.size || f.pv !== standard.pv || f.noteSize !== FULL_NOTE_SIZE[d.docType]) throw new Error(`${set.key}: the fit changed`);
            if (pdfPageCount(await renderFrontPage(d)) > 1) {
                spills = noteH(notes) - rowsLeft;
                break;
            }
            fits = noteH(notes) - rowsLeft;
        }
        console.log(`${set.key.padEnd(8)} ${base.docType.padEnd(18)} ${base.papers.length} papers  spare: fits at ${fits.toFixed(1)}, spills at ${spills.toFixed(1)}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
