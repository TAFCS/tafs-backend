/**
 * TAFSD-528: render admit cards / statements of entry for every segment from the
 * school's December 2026 schedules (scripts/data/exam-schedules-dec-2026.ts) and
 * made-up students, through the same page builder and PDF the service uses.
 * No database. Writes one PDF per segment.
 *   npx ts-node --transpile-only scripts/exam-docs-preview.ts <outDir>
 */
/* eslint-disable */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { ExamDocumentsPDF } from '../src/modules/exam-documents/ExamDocumentPDF';
import { buildExamDocPage, ExamDocPageInput } from '../src/modules/exam-documents/exam-document-page';
import { DEC_2026_SCHEDULES, toUpsertBody } from './data/exam-schedules-dec-2026';

const OUT = process.argv[2] || path.join(os.tmpdir(), 'exam-docs-preview');
const CLASS_NAME: Record<number, string> = {
    4: 'JR. I', 9: 'SR. I', 12: 'O-I', 14: 'O-III', 15: 'VI', 18: 'IX', 20: 'AS', 21: 'A2',
};

const STUDENTS: ExamDocPageInput['student'][] = [
    { cc: 4137, gr: '6120', fullName: 'Hamza Arif', father: 'Muhammad Arif Siddiqui', dob: new Date('2014-05-22'), gender: 'Male' },
    // Missing G.R., father and date of birth: those boxes show a centred dash.
    { cc: 7412, gr: null, fullName: 'Ayesha Kamran Qureshi', father: '', dob: null, gender: 'Female' },
];

/** No A Level schedule was circulated for December; a made-up AS / A2 one with Cambridge codes. */
const A_LEVEL = {
    title: 'FIRST SEMESTER ASSESSMENTS',
    segment_line: 'A LEVELS',
    academic_year: '2026-2027',
    notes: [] as string[],
    papers: [
        ['2026-12-11', 'MATHEMATICS', '9709 / 12'], ['2026-12-12', 'PHYSICS', '9702 / 22'], ['2026-12-14', 'CHEMISTRY', '9701 / 22'],
        ['2026-12-15', 'BIOLOGY', '9700 / 22'], ['2026-12-16', 'ENGLISH GENERAL PAPER', '8021 / 12'], ['2026-12-17', 'COMPUTER SCIENCE', '9618 / 12'],
    ].map(([d, subject, code]) => ({ class_id: 20, paper_date: d, time_text: '8:00 – 11:30', subject, code })),
};

const SETS: { file: string; classId: number; body: any }[] = [
    { file: '1 Junior - Jr I - Statement of entry', classId: 4, body: toUpsertBody(DEC_2026_SCHEDULES.find((s) => s.key === 'jr')!) },
    { file: '2 Senior - Sr I - Statement of entry', classId: 9, body: toUpsertBody(DEC_2026_SCHEDULES.find((s) => s.key === 'sr')!) },
    { file: '3 O Level - O-I - Statement of entry', classId: 12, body: toUpsertBody(DEC_2026_SCHEDULES.find((s) => s.key === 'o')!) },
    { file: '3b O Level - O-III - Statement of entry', classId: 14, body: toUpsertBody(DEC_2026_SCHEDULES.find((s) => s.key === 'o')!) },
    { file: '4 A Level - AS - Statement of entry', classId: 20, body: A_LEVEL },
    { file: '5 Secondary - VI - Admit card', classId: 15, body: toUpsertBody(DEC_2026_SCHEDULES.find((s) => s.key === 'vi-viii')!) },
    { file: '6 Secondary - IX - Admit card', classId: 18, body: toUpsertBody(DEC_2026_SCHEDULES.find((s) => s.key === 'ix-x')!) },
];

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    for (const set of SETS) {
        const b = set.body;
        const pages = STUDENTS.map((student, i) =>
            buildExamDocPage({
                schedule: {
                    title: b.title,
                    segmentLine: b.segment_line ?? null,
                    academicYear: b.academic_year,
                    notes: b.notes,
                    campusName: 'CAMPUS # II',
                    campusAddress: null,
                    papers: b.papers.map((p: any) => ({ ...p, paper_date: new Date(`${p.paper_date}T00:00:00Z`), code: p.code ?? null })),
                },
                classId: set.classId,
                className: CLASS_NAME[set.classId],
                sectionName: 'A',
                serialNo: 7 + i,
                issuedAt: new Date('2026-12-09T05:00:00Z'),
                student,
                photo: null,
            }),
        );
        const buf = await renderToBuffer(React.createElement(ExamDocumentsPDF, { pages, title: set.file }) as any);
        const file = path.join(OUT, `${set.file}.pdf`);
        fs.writeFileSync(file, buf);
        // A page that spills over adds a sheet: a statement of entry is 2 pages, an admit card 1.
        const got = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
        const want = pages.reduce((n, d) => n + (d.notice ? 2 : 1), 0);
        if (got !== want) throw new Error(`${set.file}: ${got} pages, expected ${want} (a page overflowed)`);
        console.log(file);
    }
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
