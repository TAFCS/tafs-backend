/**
 * TAFSD-603: sample PDFs of every document that prints a campus's document footer, through the
 * same code the service uses: statements of entry and admit cards (exam-document-page.ts +
 * ExamDocumentPDF), leaving certificates on each campus's blank (slc-template.ts), and the
 * strips the Setup > Campuses preview shows (campus-footer-preview.ts). Made-up students, no
 * database. The footers are the ones printed on the school's leaving-certificate blanks, typed
 * as an admin would type them.
 *   npx ts-node --transpile-only scripts/campus-footer-samples.ts <outDir>
 */
/* eslint-disable */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { ExamDocumentsPDF } from '../src/modules/exam-documents/ExamDocumentPDF';
import { pdfPageCount, renderFrontPage, settleFrontFit } from '../src/modules/exam-documents/exam-front-fit';
import { buildExamDocPage, ExamDocPageInput } from '../src/modules/exam-documents/exam-document-page';
import { SLC_TEMPLATES, SlcCertificateData, fillLeavingCertificate } from '../src/modules/enrollments/slc-template';
import { campusFooterPreview } from '../src/modules/campuses/campus-footer-preview';
import { DEC_2026_SCHEDULES, toUpsertBody } from './data/exam-schedules-dec-2026';

const OUT = process.argv[2] || path.join(os.tmpdir(), 'campus-footer-samples');

const FOOTERS = {
    GEJ: [
        'C-61, 62, 63, 64 & 65, BLOCK - 13, GULISTAN-E-JAUHAR, KARACHI, PAKISTAN.',
        'Phone: 3461-2878, 3461-2879, 3461-2880 · Fax: (92-21) 3461-2881 · Helpline: 0300-8258061',
        'E-mail: american@cyber.net.pk · info@tafs.edu.pk · Website: www.tafs.edu.pk',
    ],
    KNF: [
        'B-2, BLOCK # 2, GULSHAN-E-KANEEZ FATIMA SOCIETY, GULZAR-E-HIJRI, SCHEME # 33, KARACHI, PAKISTAN.',
        'Phone: 3469-0972, 3469-0973, 3469-0975 · Fax: (92-21) 3469-0978',
        'E-mail: american@cyber.net.pk · Website: www.tafs.edu.pk',
    ],
    NNZ: ['C-22, BLOCK - I, NORTH NAZIMABAD, KARACHI, PAKISTAN.', 'Phone: 3663-0051, 3663-0052 · E-mail: american@cyber.net.pk · Website: www.tafs.edu.pk'],
};

const GEJ = {
    id: 1,
    campus_name: 'Gulistan-e-Johar Campus',
    // As stored on the campus record in production: phone and fax typed into the address.
    address: 'C-61, 62, 63, 64 & 65, Block 13, Gulistan-e-Jauhar, Karachi · Phone (92-21) 3476-5111-13 · Fax (92-21) 3476-5114',
    uan_number: '111-000-000',
};

const STUDENT: ExamDocPageInput['student'] = {
    cc: 4137,
    gr: '6120',
    fullName: 'Hamza Arif',
    father: 'Muhammad Arif Siddiqui',
    dob: new Date('2009-05-22'),
    gender: 'Male',
    discipline: 'Computer',
};

const SLC: SlcCertificateData = {
    cc: '10482',
    gr_number: 'AL-2211',
    slc_number: '271',
    name: { last: 'SIDDIQUI', first: 'MUHAMMAD', middle: 'HASSAN' },
    father_name: { last: 'SIDDIQUI', first: 'ABDUL', middle: 'REHMAN' },
    dob: { month: 'MARCH', day: '14', year: '2007' },
    nationality: 'PAKISTANI',
    gender: 'MALE',
    religion: 'MUSLIM',
    present_level: 'A2 CAMBRIDGE',
    reason_for_leaving: "ON PARENT'S REQUEST",
    day: 'TUESDAY',
    date: 'NOVEMBER 24, 2026',
};

const pageCount = (b: Buffer | Uint8Array) => (Buffer.from(b).toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

async function examDoc(file: string, scheduleKey: string, classId: number, className: string, footer: string[]) {
    const b = toUpsertBody(DEC_2026_SCHEDULES.find((s) => s.key === scheduleKey)!);
    const d = buildExamDocPage({
        schedule: {
            title: b.title,
            segmentLine: b.segment_line ?? null,
            academicYear: b.academic_year,
            notes: b.notes,
            campusName: GEJ.campus_name,
            campusAddress: GEJ.address,
            campusUan: GEJ.uan_number,
            campusFooter: footer,
            papers: b.papers.map((p: any) => ({ ...p, paper_date: new Date(`${p.paper_date}T00:00:00Z`), code: p.code ?? null })),
        },
        classId,
        className,
        sectionName: 'A',
        serialNo: 7,
        issuedAt: new Date('2026-12-09T05:00:00Z'),
        student: STUDENT,
        photo: null,
    });
    const buf = await renderToBuffer(React.createElement(ExamDocumentsPDF, { pages: [d], title: file }) as any);
    const want = d.notice ? 2 : 1;
    if (pageCount(buf) !== want) throw new Error(`${file}: ${pageCount(buf)} pages, expected ${want}`);
    write(file, buf);
}

function write(file: string, buf: Buffer | Uint8Array) {
    const p = path.join(OUT, `${file}.pdf`);
    fs.writeFileSync(p, buf);
    console.log(p);
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });

    await examDoc('1 Statement of entry (Sr I) - GEJ footer', 'sr', 9, 'SR. I', FOOTERS.GEJ);
    await examDoc('2 Admit card (IX) - GEJ footer', 'ix-x', 18, 'IX', FOOTERS.GEJ);
    await examDoc('3 Statement of entry (Sr I) - no footer set, address and UAN as before', 'sr', 9, 'SR. I', []);

    write('4 Leaving certificate - TAFSAL Gulistan-e-Jauhar - GEJ footer', await fillLeavingCertificate(SLC, SLC_TEMPLATES['tafsal-jauhar'], FOOTERS.GEJ));
    write('5 Leaving certificate - TAFSS Gulistan-e-Jauhar - GEJ footer', await fillLeavingCertificate(SLC, SLC_TEMPLATES['tafss-jauhar'], FOOTERS.GEJ));
    write('6 Leaving certificate - TAFSAL Kaneez Fatima - KNF footer', await fillLeavingCertificate(SLC, SLC_TEMPLATES['tafsal-kaneez-fatima'], FOOTERS.KNF));
    write('7 Leaving certificate - TAFSAL North Nazimabad - NNZ footer', await fillLeavingCertificate(SLC, SLC_TEMPLATES['tafsal-north-nazimabad'], FOOTERS.NNZ));
    write('8 Leaving certificate - no footer set, blank footer as before', await fillLeavingCertificate(SLC, SLC_TEMPLATES['tafsal-jauhar'], []));

    // A three-line footer takes about 10pt from the front page. Every December 2026 schedule, with
    // the standard lines and with a long front note, must still hold on one sheet when rendered.
    const LONG_NOTE = Array<string>(5).fill('NO LENDING OR BORROWING WILL BE ALLOWED, STUDENTS HAVE TO BRING TRANSPARENT POUCHES.');
    const CLASSES: [string, number][] = [['jr', 4], ['sr', 9], ['o', 12], ['o', 14], ['vi-viii', 15], ['ix-x', 18]];
    for (const [key, classId] of CLASSES) {
        const b = toUpsertBody(DEC_2026_SCHEDULES.find((s) => s.key === key)!);
        for (const documentNotes of [[], LONG_NOTE]) {
            const d = buildExamDocPage({
                schedule: {
                    title: b.title, segmentLine: b.segment_line ?? null, academicYear: b.academic_year, notes: b.notes, documentNotes,
                    campusName: GEJ.campus_name, campusAddress: GEJ.address, campusFooter: FOOTERS.GEJ,
                    papers: b.papers.map((p: any) => ({ ...p, paper_date: new Date(`${p.paper_date}T00:00:00Z`), code: p.code ?? null })),
                },
                classId, className: String(classId), sectionName: 'A', serialNo: 1, issuedAt: new Date('2026-12-09T05:00:00Z'), student: STUDENT, photo: null,
            });
            const settled = await settleFrontFit(d);
            const pages = pdfPageCount(await renderFrontPage({ ...d, frontSlack: settled.slack }));
            if (!settled.fits || pages !== 1) throw new Error(`class ${classId} (${documentNotes.length ? 'own note' : 'standard lines'}): front page spills`);
            console.log(`   front page holds: class ${classId}, ${documentNotes.length ? 'own note' : 'standard lines'}, slack ${settled.slack}, note ${settled.fit.noteSize}pt`);
        }
    }

    // What Setup > Campuses shows while typing: a footer that fits, one that shrinks, one that overflows.
    const drafts: [string, string[]][] = [
        ['9a Preview strips - GEJ footer', FOOTERS.GEJ],
        ['9b Preview strips - long line shrinks', [...FOOTERS.GEJ.slice(0, 2), 'E-mail: american@cyber.net.pk · info@tafs.edu.pk · admissions@tafs.edu.pk · Website: www.tafs.edu.pk · Facebook: /tafs.official']],
        ['9c Preview strips - too long, refused', [FOOTERS.GEJ[0] + ' ' + FOOTERS.GEJ[1] + ' ' + FOOTERS.GEJ[2]]],
    ];
    for (const [file, lines] of drafts) {
        const p = await campusFooterPreview(GEJ, lines);
        for (const a of p.areas) write(`${file} - ${a.label}`, Buffer.from(a.pdf_base64, 'base64'));
        console.log('  ', JSON.stringify({ problems: p.problems, areas: p.areas.map((a) => ({ id: a.id, fits: a.fits, sizes: a.lines.map((l) => l.size) })) }));
    }
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
