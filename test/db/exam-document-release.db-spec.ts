/**
 * TAFSD-544: releasing issued exam documents to the parent app, end to end
 * through the real guards into a real Postgres.
 *
 * Covered: a release puts a card on the family's feed only for issued,
 * unreleased documents of students with a parent account, and reports the
 * others; a second release changes nothing; the roster shows the release and
 * when the parent opened it; a family sees only its own cards, reads them and
 * opens the PDF; another family cannot; release needs its own action.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, CLASS_AUG, STUDENT, USERS, YEAR, seedSchool } from './helpers/fixtures';

const TILE = 'student.exam_documents';
const FAMILY = 701;
const OTHER_FAMILY = 702;

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let staff: Record<'admin' | 'clerk', ReturnType<typeof client>>;
let parent: ReturnType<typeof client>;
let otherParent: ReturnType<typeof client>;
let scheduleId: number;

const parentToken = (familyId: number) => jwt.sign({ sub: familyId, familyId, userType: 'PARENT' });

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);

    await prisma.families.createMany({
        data: [
            { id: FAMILY, household_name: 'Family of One', password_hash: 'x' },
            { id: OTHER_FAMILY, household_name: 'Family of Two', password_hash: 'x' },
        ],
    });
    // A1 belongs to FAMILY, A2 has no parent account.
    await prisma.students.update({ where: { cc: STUDENT.A1 }, data: { family_id: FAMILY } });

    const schedule = await prisma.exam_schedules.create({
        data: {
            campus_id: CAMPUS_A,
            academic_year: YEAR,
            title: 'FIRST SEMESTER ASSESSMENTS',
            fee_date: new Date('2026-12-01'),
            status: 'PUBLISHED',
            exam_schedule_classes: { create: [{ class_id: CLASS_AUG }] },
            exam_schedule_papers: {
                create: [
                    { class_id: CLASS_AUG, paper_date: new Date('2026-12-14'), time_text: '8:00 – 11:30', subject: 'ENGLISH' },
                    { class_id: CLASS_AUG, paper_date: new Date('2026-12-11'), time_text: '8:00 – 11:30', subject: 'MATHEMATICS' },
                ],
            },
        },
    });
    scheduleId = schedule.id;

    // The campus-A clerk can open Exam Documents but has no release grant.
    await prisma.user_tile_grants.create({ data: { user_id: USERS.clerk.id, tile_id: TILE, allow: true, granted_by: USERS.admin.id } });

    staff = { admin: client(app, tokenFor(jwt, USERS.admin)), clerk: client(app, tokenFor(jwt, USERS.clerk)) };
    parent = client(app, parentToken(FAMILY));
    otherParent = client(app, parentToken(OTHER_FAMILY));
});

afterAll(async () => {
    await app?.close();
});

beforeEach(async () => {
    await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "exam_document_notifications", "exam_document_runs", "exam_documents", "audit_logs" RESTART IDENTITY CASCADE',
    );
    // A1 and A2 owe nothing, so both can be issued.
    const res = await staff.admin.post(`/exam-documents/schedules/${scheduleId}/documents`).send({ student_ids: [STUDENT.A1, STUDENT.A2] });
    expect(res.headers['x-issued-count']).toBe('2');
});

const release = (body: object) => staff.admin.post(`/exam-documents/schedules/${scheduleId}/documents/release`).send(body);

describe('releasing to the parent app', () => {
    it('puts a card on the family feed for issued documents only and reports the rest', async () => {
        const res = await release({ student_ids: [STUDENT.A1, STUDENT.A2, STUDENT.A_APR], message: '  Bring this every day.\nGates close at 7:45. ' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ released: 1, already_released: 0, not_issued: 1, no_family: 1, not_found: 0 });
        expect(res.body.data.students).toEqual([
            { cc: STUDENT.A1, name: 'Test Student One', outcome: 'RELEASED', reason: 'Released' },
            { cc: STUDENT.A2, name: 'Test Student Two', outcome: 'NO_FAMILY', reason: 'No parent account linked' },
            { cc: STUDENT.A_APR, name: 'Test Student April', outcome: 'NOT_ISSUED', reason: 'Not issued yet' },
        ]);

        const doc = await prisma.exam_documents.findFirstOrThrow({ where: { student_id: STUDENT.A1 } });
        expect(doc.released_by).toBe(USERS.admin.username);
        expect(doc.release_message).toBe('Bring this every day.\nGates close at 7:45.');

        const feed = await parent.get('/exam-document-notifications');
        expect(feed.status).toBe(200);
        expect(feed.body.data).toHaveLength(1);
        expect(feed.body.data[0]).toMatchObject({
            student_cc: STUDENT.A1,
            exam_document_id: doc.id,
            doc_type: doc.doc_type,
            title: doc.doc_type === 'ADMIT_CARD' ? 'Admit Card ready' : 'Statement of Entry ready',
            message: 'Bring this every day.\nGates close at 7:45.',
            read_at: null,
            opened_at: null,
            student: { cc: STUDENT.A1, full_name: 'Test Student One', class_name: 'Class VI', section_name: 'A' },
            document: { serial: '0001', assessment: 'FIRST SEMESTER ASSESSMENTS', academic_year: YEAR, first_paper_date: '2026-12-11', campus_name: 'Test Campus A' },
        });
        expect(feed.body.data[0].body).toMatch(/^Test Student One's First Semester Assessments .* is in the app\. Bring this every day\.$/);
    });

    it('does nothing the second time', async () => {
        await release({ student_ids: [STUDENT.A1] });
        const again = await release({ student_ids: [STUDENT.A1], message: 'A different message' });
        expect(again.body.data).toMatchObject({ released: 0, already_released: 1 });
        expect(await prisma.exam_document_notifications.count()).toBe(1);
        expect((await prisma.exam_documents.findFirstOrThrow({ where: { student_id: STUDENT.A1 } })).release_message).toBeNull();
    });

    it('shows the release on the roster, and when the parent opened it', async () => {
        await release({ student_ids: [STUDENT.A1] });
        const before = await staff.admin.get(`/exam-documents/schedules/${scheduleId}/students`);
        const row = (cc: number, body: any) => body.data.rows.find((r: any) => r.cc === cc);
        expect(row(STUDENT.A1, before.body).document).toMatchObject({ released_by: USERS.admin.username, parent_opened_at: null });
        expect(row(STUDENT.A1, before.body).document.released_at).toBeTruthy();
        expect(row(STUDENT.A2, before.body).document.released_at).toBeNull();

        const [card] = (await parent.get('/exam-document-notifications')).body.data;
        const pdf = await parent.get(`/exam-document-notifications/${card.id}/pdf`);
        expect(pdf.status).toBe(200);
        expect(pdf.headers['content-type']).toContain('application/pdf');

        const after = await staff.admin.get(`/exam-documents/schedules/${scheduleId}/students`);
        expect(row(STUDENT.A1, after.body).document.parent_opened_at).toBeTruthy();
        const n = await prisma.exam_document_notifications.findFirstOrThrow();
        expect(n.read_at).toBeTruthy();
    });

    it("keeps each family to its own cards", async () => {
        await release({ student_ids: [STUDENT.A1] });
        const [card] = (await parent.get('/exam-document-notifications')).body.data;

        expect((await otherParent.get('/exam-document-notifications')).body.data).toEqual([]);
        expect((await otherParent.get(`/exam-document-notifications/${card.id}/pdf`)).status).toBe(404);
        expect((await otherParent.post(`/exam-document-notifications/${card.id}/read`)).status).toBe(404);

        const read = await parent.post(`/exam-document-notifications/${card.id}/read`);
        expect(read.status).toBe(201);
        expect(read.body.data.read_at).toBeTruthy();

        // A staff token is not a parent token.
        expect((await staff.admin.get('/exam-document-notifications')).status).toBe(401);
    });

    it('undoes a release: the card leaves the app, and a new release sends a new one', async () => {
        await release({ student_ids: [STUDENT.A1] });
        const undo = await staff.admin.post(`/exam-documents/schedules/${scheduleId}/documents/unrelease`).send({ student_ids: [STUDENT.A1, STUDENT.A2] });
        expect(undo.status).toBe(200);
        expect(undo.body.data).toMatchObject({ unreleased: 1, not_released: 1, not_found: 0 });
        expect((await parent.get('/exam-document-notifications')).body.data).toEqual([]);
        const doc = await prisma.exam_documents.findFirstOrThrow({ where: { student_id: STUDENT.A1 } });
        expect([doc.released_at, doc.released_by, doc.release_message]).toEqual([null, null, null]);

        const again = await release({ student_ids: [STUDENT.A1], message: 'Second time' });
        expect(again.body.data.released).toBe(1);
        const feed = (await parent.get('/exam-document-notifications')).body.data;
        expect(feed).toHaveLength(1);
        expect(feed[0].message).toBe('Second time');
    });

    it('needs the release action', async () => {
        const res = await staff.clerk.post(`/exam-documents/schedules/${scheduleId}/documents/release`).send({ student_ids: [STUDENT.A1] });
        expect(res.status).toBe(403);
        expect(await prisma.exam_document_notifications.count()).toBe(0);
        const undo = await staff.clerk.post(`/exam-documents/schedules/${scheduleId}/documents/unrelease`).send({ student_ids: [STUDENT.A1] });
        expect(undo.status).toBe(403);
    });
});
