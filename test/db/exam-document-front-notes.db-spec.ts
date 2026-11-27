/**
 * TAFSD-555: a schedule's front note (the box under the papers on the front of
 * every statement of entry and admit card), end to end through the real guards
 * into a real Postgres.
 *
 * Covered: the front note is saved and read back apart from the schedule sheet's
 * notes, typed numbering is dropped, editing replaces it, more than twelve lines
 * is refused, a schedule saved without the field keeps an empty note (the
 * standard lines), a preset carries it, documents issue with it, and the editor's
 * live preview lays out each class's front page from an unsaved draft. (react-pdf is
 * stubbed here, so whether a page spills is covered by exam-front-fit.spec.ts.)
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, CLASS_AUG, STUDENT, USERS, YEAR, seedSchool } from './helpers/fixtures';

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let admin: ReturnType<typeof client>;

const body = (over: object = {}) => ({
    campus_id: CAMPUS_A,
    academic_year: YEAR,
    title: 'FIRST SEMESTER ASSESSMENTS',
    fee_date: '2026-12-01',
    notes: ['ADMIT CARDS WILL BE ISSUED ON 9 DECEMBER.', 'THE RESULT WILL BE DISTRIBUTED IN THE PTM ON 30 JANUARY.'],
    class_ids: [CLASS_AUG],
    papers: [{ class_id: CLASS_AUG, paper_date: '2026-12-14', time_text: '8:00 – 11:30', subject: 'ENGLISH' }],
    ...over,
});

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    await prisma.campus_classes.create({ data: { campus_id: CAMPUS_A, class_id: CLASS_AUG } });
    admin = client(app, tokenFor(jwt, USERS.admin));
});

afterAll(async () => {
    await app?.close();
});

describe('the front note on a schedule', () => {
    it('saves apart from the schedule notes, edits and reads back', async () => {
        const created = await admin.post('/exam-documents/schedules').send(body({ document_notes: ['1. Reach 15 minutes early.', '  ', '• Only simple calculators.'] }));
        expect(created.status).toBe(201);
        const id = created.body.data.id;
        expect(created.body.data.document_notes).toEqual(['Reach 15 minutes early.', 'Only simple calculators.']);
        expect(created.body.data.notes).toHaveLength(2);

        const edited = await admin.put(`/exam-documents/schedules/${id}`).send(body({ document_notes: ['No bags in the hall.'] }));
        expect(edited.status).toBe(200);
        expect((await admin.get(`/exam-documents/schedules/${id}`)).body.data.document_notes).toEqual(['No bags in the hall.']);
    });

    it('keeps an empty note (the standard lines) when the editor sends none', async () => {
        const created = await admin.post('/exam-documents/schedules').send(body());
        expect(created.status).toBe(201);
        expect(created.body.data.document_notes).toEqual([]);
    });

    it('refuses more than twelve lines, so the front stays one page', async () => {
        const res = await admin.post('/exam-documents/schedules').send(body({ document_notes: Array(13).fill('A line.') }));
        expect(res.status).toBe(400);
    });

    it('carries the front note on a preset', async () => {
        const res = await admin.post('/exam-documents/presets').send({
            name: 'Mid-Year VI',
            layout: 'SECONDARY',
            title: 'MID-YEAR EXAMINATION',
            class_ids: [CLASS_AUG],
            rows: [{ time: '8:00 – 10:30', cells: { [CLASS_AUG]: 'ENGLISH' } }],
            notes: [],
            document_notes: ['Bring a clear pouch.'],
        });
        expect(res.status).toBe(201);
        const list = await admin.get('/exam-documents/presets');
        expect(list.body.data.find((p: { name: string }) => p.name === 'Mid-Year VI').document_notes).toEqual(['Bring a clear pouch.']);
    });

    it('issues documents with a front note', async () => {
        const created = await admin.post('/exam-documents/schedules').send(body({ document_notes: ['Reach 15 minutes early.'] }));
        const id = created.body.data.id;
        expect((await admin.patch(`/exam-documents/schedules/${id}/status`).send({ status: 'PUBLISHED' })).status).toBe(200);
        const res = await admin.post(`/exam-documents/schedules/${id}/documents`).send({ student_ids: [STUDENT.A1] });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('application/pdf');
        expect(res.headers['x-issued-count']).toBe('1');
    });

    it("previews an unsaved draft's front page per class", async () => {
        const res = await admin.post('/exam-documents/schedules/front-note-preview').send({
            campus_id: CAMPUS_A,
            academic_year: YEAR,
            title: 'FIRST SEMESTER ASSESSMENTS',
            document_notes: ['1. Reach 15 minutes early.', 'Only simple calculators.'],
            class_ids: [CLASS_AUG],
            // A row still being typed: no date, no time.
            papers: [{ class_id: CLASS_AUG, subject: 'ENGLISH' }],
        });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ lines: 2, max_lines: 12, shown_class_id: CLASS_AUG, tightest_class_id: CLASS_AUG });
        expect(res.body.data.classes).toEqual([
            expect.objectContaining({ class_id: CLASS_AUG, papers: 1, standard_lines: false, fits: true, shrunk: false }),
        ]);
        expect(typeof res.body.data.pdf_base64).toBe('string');
    });

    it('previews the standard lines when the front note is empty', async () => {
        const res = await admin
            .post('/exam-documents/schedules/front-note-preview')
            .send({ campus_id: CAMPUS_A, document_notes: [], class_ids: [CLASS_AUG], papers: [] });
        expect(res.status).toBe(200);
        expect(res.body.data.classes[0]).toMatchObject({ standard_lines: true, fits: true });
    });
});
