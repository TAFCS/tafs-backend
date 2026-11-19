/**
 * TAFSD-543: an Issue run on an exam schedule issues to the students who can
 * have a document and reports everyone else with the reason, end to end through
 * the real guards into a real Postgres.
 *
 * Covered: a mixed run (cleared, owing on a voucher, owing only unbilled fees,
 * class not on the schedule, another campus, unknown C.C.) issues to the cleared
 * student only and records every other student with their reason; the run id
 * comes back with the PDF; a run with nothing to print answers with the report
 * instead; holders are reprinted, or left alone with skip_holders; the report
 * lists, opens and exports as Excel; a viewer scoped to one campus sees only
 * their own students in it and cannot issue.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import * as ExcelJS from 'exceljs';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, CAMPUS_B, CLASS_AUG, FEE, SECTION, STUDENT, USERS, YEAR, seedSchool } from './helpers/fixtures';

const TILE = 'student.exam_documents';
const UNBILLED = 9004; // campus A, on the schedule, owes only a head never put on a voucher
const UNKNOWN = 999999;

let app: INestApplication;
let prisma: PrismaService;
let as: Record<'admin' | 'clerk', ReturnType<typeof client>>;
let scheduleId: number;

/** supertest buffers a PDF or xlsx reply into res.body only with a parser. */
const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

beforeAll(async () => {
    let jwt: JwtService;
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);

    await prisma.students.create({
        data: { cc: UNBILLED, full_name: 'Test Student Unbilled', status: 'ENROLLED', campus_id: CAMPUS_A, class_id: CLASS_AUG, section_id: SECTION, gr_number: 'GR-9004' },
    });
    // A1 owes November on a voucher; UNBILLED owes November never billed. A2 owes nothing.
    await prisma.student_fees.createMany({
        data: [
            { student_id: STUDENT.A1, fee_type_id: FEE.MTF, academic_year: YEAR, target_month: 11, amount: 18995, fee_date: new Date('2026-11-01'), status: 'ISSUED' },
            { student_id: UNBILLED, fee_type_id: FEE.MTF, academic_year: YEAR, target_month: 11, amount: 18995, fee_date: new Date('2026-11-01'), status: 'NOT_ISSUED' },
            // After the fee date: does not count.
            { student_id: STUDENT.A2, fee_type_id: FEE.MTF, academic_year: YEAR, target_month: 1, amount: 18995, fee_date: new Date('2027-01-01'), status: 'ISSUED' },
        ],
    });

    const schedule = await prisma.exam_schedules.create({
        data: {
            campus_id: CAMPUS_A,
            academic_year: YEAR,
            title: 'FIRST SEMESTER ASSESSMENTS',
            fee_date: new Date('2026-12-01'),
            status: 'PUBLISHED',
            exam_schedule_classes: { create: [{ class_id: CLASS_AUG }] },
            exam_schedule_papers: {
                create: [{ class_id: CLASS_AUG, paper_date: new Date('2026-12-11'), time_text: '8:00 – 11:30', subject: 'MATHEMATICS' }],
            },
        },
    });
    scheduleId = schedule.id;

    // The campus-A clerk can open Exam Documents (view only) and nothing else.
    await prisma.user_tile_grants.create({ data: { user_id: USERS.clerk.id, tile_id: TILE, allow: true, granted_by: USERS.admin.id } });

    as = { admin: client(app, tokenFor(jwt, USERS.admin)), clerk: client(app, tokenFor(jwt, USERS.clerk)) };
});

afterAll(async () => {
    await app?.close();
});

beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "exam_document_runs", "exam_documents", "audit_logs" RESTART IDENTITY CASCADE');
});

const issue = (body: object) => as.admin.post(`/exam-documents/schedules/${scheduleId}/documents`).send(body).buffer(true).parse(binary);

describe('an issue run', () => {
    it('issues to the cleared student and reports every other one with the reason', async () => {
        const res = await issue({ student_ids: [STUDENT.A1, STUDENT.A2, UNBILLED, STUDENT.A_APR, STUDENT.B1, UNKNOWN] });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('application/pdf');
        expect(res.headers['x-issued-count']).toBe('1');
        expect(res.headers['x-skipped-count']).toBe('5');
        const runId = Number(res.headers['x-run-id']);
        expect(runId).toBeGreaterThan(0);

        const docs = await prisma.exam_documents.findMany();
        expect(docs.map((d) => d.student_id)).toEqual([STUDENT.A2]);

        const report = await as.admin.get(`/exam-documents/schedules/${scheduleId}/runs/${runId}`);
        expect(report.status).toBe(200);
        const r = report.body.data;
        expect(r.counts).toEqual({ requested: 6, issued: 1, reprinted: 0, skipped: 5, with_gaps: 1 });
        expect(r.label).toBe('Class VI – A, O-Level I – A');
        const byCc = new Map<number, any>(r.students.map((s: any) => [s.cc, s]));
        expect(byCc.get(STUDENT.A2)).toMatchObject({ outcome: 'ISSUED', serial: '0001', fee_date: '2026-12-01', gaps: ['NO_PHOTO', 'NO_FATHER', 'NO_DOB'] });
        expect(byCc.get(STUDENT.A1)).toMatchObject({
            outcome: 'SKIPPED',
            reason_code: 'DUES_NOT_CLEARED',
            reason: 'Owes Rs 18,995 through 1 Dec 2026 (Nov 2026)',
            owed: 18995,
            fee_date: '2026-12-01',
        });
        expect(byCc.get(UNBILLED)).toMatchObject({ outcome: 'SKIPPED', reason_code: 'NOT_BILLED', owed: 18995 });
        expect(byCc.get(STUDENT.A_APR)).toMatchObject({ outcome: 'SKIPPED', reason_code: 'CLASS_NOT_ON_SCHEDULE' });
        expect(byCc.get(STUDENT.B1)).toMatchObject({ outcome: 'SKIPPED', reason_code: 'OTHER_CAMPUS' });
        expect(byCc.get(UNKNOWN)).toMatchObject({ outcome: 'SKIPPED', reason_code: 'NOT_FOUND', name: `C.C. ${UNKNOWN}` });
        // Skipped students come first.
        expect(r.students.slice(0, 5).every((s: any) => s.outcome === 'SKIPPED')).toBe(true);
    });

    it('answers with the report when nothing could be printed', async () => {
        const res = await as.admin.post(`/exam-documents/schedules/${scheduleId}/documents`).send({ student_ids: [STUDENT.A1, UNBILLED] });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('application/json');
        expect(res.body.data).toMatchObject({ issued: 0, reprinted: 0, skipped: 2, error: null });
        expect(res.body.data.run_id).toBe(Number(res.headers['x-run-id']));
        expect(await prisma.exam_documents.count()).toBe(0);
    });

    it('reprints holders, or leaves them alone with skip_holders', async () => {
        await issue({ student_ids: [STUDENT.A2] });
        const again = await issue({ student_ids: [STUDENT.A2] });
        expect(again.headers['x-reprinted-count']).toBe('1');
        expect((await prisma.exam_documents.findFirstOrThrow()).print_count).toBe(2);

        const whole = await as.admin
            .post(`/exam-documents/schedules/${scheduleId}/documents`)
            .send({ student_ids: [STUDENT.A2, STUDENT.A1], skip_holders: true });
        expect(whole.headers['content-type']).toContain('application/json');
        expect((await prisma.exam_documents.findFirstOrThrow()).print_count).toBe(2);
        const report = await as.admin.get(`/exam-documents/schedules/${scheduleId}/runs/${whole.body.data.run_id}`);
        const held = report.body.data.students.find((s: any) => s.cc === STUDENT.A2);
        expect(held).toMatchObject({ outcome: 'SKIPPED', reason_code: 'ALREADY_ISSUED', serial: '0001' });
        expect(held.reason).toMatch(/^Already has #0001, issued /);
    });
});

describe('run reports', () => {
    it('lists runs newest first and exports one as Excel', async () => {
        await issue({ student_ids: [STUDENT.A2] });
        await issue({ student_ids: [STUDENT.A1, STUDENT.A2] });

        const list = await as.admin.get(`/exam-documents/schedules/${scheduleId}/runs`);
        expect(list.status).toBe(200);
        expect(list.body.data.map((r: any) => [r.requested, r.issued, r.reprinted, r.skipped])).toEqual([
            [2, 0, 1, 1],
            [1, 1, 0, 0],
        ]);
        expect(list.body.data[0].students).toBeUndefined();

        const xlsx = await as.admin.get(`/exam-documents/schedules/${scheduleId}/runs/${list.body.data[0].id}/export`).buffer(true).parse(binary);
        expect(xlsx.status).toBe(200);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(xlsx.body);
        const ws = wb.getWorksheet('Report')!;
        expect(ws.getRow(7).getCell(1).value).toBe(STUDENT.A1);
        expect(ws.getRow(7).getCell(6).value).toBe('Not generated');
    });

    it('shows a campus-scoped viewer only their students, and does not let them issue', async () => {
        const run = await issue({ student_ids: [STUDENT.A2, STUDENT.B1] });
        const runId = run.headers['x-run-id'];

        const seen = await as.clerk.get(`/exam-documents/schedules/${scheduleId}/runs/${runId}`);
        expect(seen.status).toBe(200);
        expect(seen.body.data.students.map((s: any) => s.cc)).toEqual([STUDENT.A2]);
        expect(seen.body.data.hidden).toBe(1);

        const denied = await as.clerk.post(`/exam-documents/schedules/${scheduleId}/documents`).send({ student_ids: [STUDENT.A2] });
        expect(denied.status).toBe(403);
    });

    it('404s a run from another schedule', async () => {
        const other = await prisma.exam_schedules.create({
            data: { campus_id: CAMPUS_B, academic_year: YEAR, title: 'OTHER', fee_date: new Date('2026-12-01'), status: 'DRAFT' },
        });
        const run = await issue({ student_ids: [STUDENT.A2] });
        const res = await as.admin.get(`/exam-documents/schedules/${other.id}/runs/${run.headers['x-run-id']}`);
        expect(res.status).toBe(404);
    });
});
