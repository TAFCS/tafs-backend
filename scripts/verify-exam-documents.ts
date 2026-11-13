/**
 * TAFSD-510: read-only checks of the exam documents service against the live
 * database, usable before the migration lands (the schedules are built in
 * memory from scripts/data/exam-schedules-dec-2026.ts).
 *
 *  1. duesThrough() agrees with an independent per-head calculation for a
 *     sample of enrolled students.
 *  2. Renders sample PDFs for real students (one per document type) into OUT_DIR.
 *
 * Every write is blocked at the client: any create / update / delete / raw
 * execute throws.
 *   npx ts-node scripts/verify-exam-documents.ts <outDir>
 */
/* eslint-disable */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient, Prisma } from '@prisma/client';
import { ExamDocumentsService } from '../src/modules/exam-documents/exam-documents.service';
import { NO_DUES, docTypeForClass, rosterState } from '../src/modules/exam-documents/exam-document-rules';
import { DEC_2026_SCHEDULES, SeedSchedule } from './data/exam-schedules-dec-2026';

const OUT = process.argv[2] || path.join(process.cwd(), 'exam-docs-verify');
const WRITE_OPS = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];

const base = new PrismaClient({ log: [] });
const prisma = base.$extends({
    query: {
        $allModels: Object.fromEntries(
            WRITE_OPS.map((op) => [op, () => { throw new Error(`BLOCKED write: ${op}`); }]),
        ) as any,
    },
}) as any;
prisma.$executeRaw = () => { throw new Error('BLOCKED write: $executeRaw'); };
prisma.$transaction = () => { throw new Error('BLOCKED write: $transaction'); };

const scope = { whereForStudents: () => ({}), assertCampus: () => undefined } as any;
const audit = { log: async () => { throw new Error('BLOCKED write: audit log'); } } as any;
// Not the real StorageService: its constructor rewrites the bucket's CORS policy.
// Photos are read over their public URLs instead.
const storage = {
    extractKeyFromUrl: (url: string) => url,
    getFile: async (url: string) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { buffer: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') || '' };
    },
} as any;
const svc = new ExamDocumentsService(prisma, scope, audit, storage) as any;

let pass = 0;
const fails: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
    if (ok) { pass++; console.log(`  ok   ${name}`); }
    else { fails.push(name); console.log(`  FAIL ${name}`, detail ?? ''); }
};

/** A schedule row shaped like SCHEDULE_INCLUDE, from the seed data. */
async function scheduleRow(seed: SeedSchedule) {
    const classIds = Object.keys(seed.grid).map(Number);
    const classes = await base.classes.findMany({ where: { id: { in: classIds } }, select: { id: true, description: true } });
    const campus = await base.campuses.findUnique({ where: { id: seed.campus_id }, select: { id: true, campus_name: true, address: true } });
    const papers = classIds.flatMap((class_id) =>
        seed.grid[class_id].map(([d, subject], i) => ({
            id: 0, schedule_id: 0, class_id, paper_date: new Date(`${d}T00:00:00Z`), time_text: seed.time_text, subject, code: null, sort_order: i,
        })),
    );
    return {
        id: 0, campus_id: seed.campus_id, academic_year: seed.academic_year, title: seed.title, segment_line: seed.segment_line,
        reference_no: seed.reference_no, fee_date: new Date(`${seed.fee_date}T00:00:00Z`),
        issue_from: new Date(`${seed.issue_from}T00:00:00Z`), notes: seed.notes, status: 'PUBLISHED',
        created_by: null, updated_by: null, created_at: new Date(), updated_at: new Date(),
        campuses: campus!,
        exam_schedule_classes: classes.map((c) => ({ schedule_id: 0, class_id: c.id, classes: c })),
        exam_schedule_papers: papers,
        _count: { exam_documents: 0, exam_schedule_fee_dates: 0 },
    };
}

/** Independent of the service's SQL: fetch the rows and add them up in JS. */
async function independentOwed(cc: number, cutoff: string): Promise<{ owed: number; notBilled: number }> {
    const heads = await base.student_fees.findMany({
        where: { student_id: cc, fee_date: { lte: new Date(`${cutoff}T00:00:00Z`) }, is_discount: false, is_arrear_surcharge: false },
        select: { amount: true, amount_before_discount: true, amount_paid: true, status: true },
    });
    let owed = new Prisma.Decimal(0);
    let notBilled = new Prisma.Decimal(0);
    for (const h of heads) {
        if (['PAID', 'DISCOUNT', 'WAIVED'].includes(String(h.status))) continue;
        const left = new Prisma.Decimal(h.amount ?? h.amount_before_discount ?? 0).sub(h.amount_paid ?? 0);
        if (left.gt(0)) owed = owed.add(left);
        if (left.gt(0) && String(h.status) === 'NOT_ISSUED') notBilled = notBilled.add(left);
    }
    const sur = await base.voucher_arrear_surcharges.findMany({
        where: {
            waived: false,
            vouchers: { student_id: cc, status: { in: ['UNPAID', 'OVERDUE', 'PARTIALLY_PAID', 'EXPIRED'] }, fee_date: { lte: new Date(`${cutoff}T00:00:00Z`) } },
        },
        select: { amount: true, amount_paid: true },
    });
    for (const s of sur) {
        const left = new Prisma.Decimal(s.amount).sub(s.amount_paid);
        if (left.gt(0)) owed = owed.add(left);
    }
    return { owed: Number(owed.toFixed(2)), notBilled: Number(notBilled.toFixed(2)) };
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const cutoff = '2026-12-01';

    console.log('1. duesThrough vs an independent calculation');
    const sample = await base.$queryRaw<{ cc: number }[]>`
        SELECT cc FROM public.students WHERE status = 'ENROLLED' ORDER BY md5(cc::text) LIMIT 80`;
    const ccs = sample.map((r) => Number(r.cc));
    const dues: Map<number, any> = await svc.duesThrough(ccs, cutoff);
    let mismatches = 0;
    for (const cc of ccs) {
        const d = dues.get(cc);
        const svcOwed = d ? Math.round((d.heads_outstanding + d.surcharge_outstanding) * 100) / 100 : 0;
        const ind = await independentOwed(cc, cutoff);
        const svcNotBilled = d ? d.not_billed_outstanding : 0;
        if (Math.abs(svcOwed - ind.owed) > 0.005 || Math.abs(svcNotBilled - ind.notBilled) > 0.005) {
            mismatches++;
            console.log(`     C.C. ${cc}: service ${svcOwed} (${svcNotBilled} not billed), independent ${ind.owed} (${ind.notBilled} not billed)`);
        }
    }
    check(`${ccs.length} sampled students owe the same through ${cutoff}`, mismatches === 0, `${mismatches} mismatches`);
    const tally: Record<string, number> = {};
    for (const cc of ccs) {
        const st = rosterState(false, dues.get(cc) ?? NO_DUES);
        tally[st] = (tally[st] ?? 0) + 1;
    }
    console.log(`     against ${cutoff}: ${JSON.stringify(tally)}`);

    console.log('2. Sample PDFs from the December schedules');
    for (const [key, classId] of [['sr', 9], ['jr', 6], ['o', 14], ['ix-x', 18], ['vi-viii', 15]] as const) {
        const seed = DEC_2026_SCHEDULES.find((s) => s.key === key)!;
        const row = await scheduleRow(seed);
        const pick = await base.students.findMany({
            where: { status: 'ENROLLED', campus_id: seed.campus_id, class_id: classId },
            orderBy: [{ photo_blue_bg_url: { sort: 'asc', nulls: 'last' } }, { cc: 'asc' }], take: 2, select: { cc: true },
        });
        if (!pick.length) console.log(`     no enrolled students in class ${classId}`);
        const students: Map<number, any> = await svc.loadStudents(pick.map((p) => p.cc), {});
        const docs = pick.map((p, i) => {
            const s = students.get(p.cc);
            return { student_id: p.cc, class_id: s.class_id, section_id: s.section_id, serial_no: i + 1, issued_at: new Date('2026-12-09T04:00:00Z'), doc_type: docTypeForClass(s.class_id) };
        });
        const buffer: Buffer = await svc.render(row, docs, students);
        const file = path.join(OUT, `${docTypeForClass(classId) === 'ADMIT_CARD' ? 'Admit card' : 'Statement of entry'} - ${row.exam_schedule_classes.find((c: any) => c.class_id === classId)!.classes.description}.pdf`);
        fs.writeFileSync(file, buffer);
        check(`${path.basename(file)}: ${docs.length} page(s), ${buffer.length} bytes`, buffer.length > 5000 && buffer.subarray(0, 4).toString() === '%PDF');
    }

    console.log(`\n${pass} passed, ${fails.length} failed`);
    if (fails.length) process.exitCode = 1;
}

main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => base.$disconnect());
