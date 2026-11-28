/**
 * TAFSD-603: a campus's document footer (Setup > Campuses), end to end through the real
 * guards into a real Postgres.
 *
 * Covered: saving cleans the lines and the campus list returns them; a line too wide for a
 * document's footer even at the smallest size, a fourth line, or a character the fonts cannot
 * print is refused and nothing changes; an empty footer clears it; the change is audited; the
 * live preview returns each document's strip and per-line sizes for an unsaved draft and
 * names its problems; a caller without the Campuses edit action gets neither. (react-pdf is
 * stubbed here; the exam strip's layout is covered by scripts/campus-footer-samples.ts, the
 * leaving certificate's by slc-template.spec.ts.)
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, USERS, seedSchool } from './helpers/fixtures';

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let admin: ReturnType<typeof client>;

const FOOTER = [
    'C-61, 62, 63, 64 & 65, BLOCK - 13, GULISTAN-E-JAUHAR, KARACHI, PAKISTAN.',
    'Phone: 3461-2878, 3461-2879 · Fax: (92-21) 3461-2881',
    'E-mail: american@cyber.net.pk · Website: www.tafs.edu.pk',
];

const stored = async () => (await prisma.campuses.findUnique({ where: { id: CAMPUS_A }, select: { document_footer: true } }))!.document_footer;

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    admin = client(app, tokenFor(jwt, USERS.admin));
});

afterAll(async () => {
    await app?.close();
});

describe('a campus document footer', () => {
    it('saves cleaned lines, lists them with the campus, and audits the change', async () => {
        const res = await admin.put(`/campuses/${CAMPUS_A}/document-footer`).send({ lines: [`  ${FOOTER[0]}  `, '', FOOTER[1], '   ', FOOTER[2]] });
        expect(res.status).toBe(200);
        expect(res.body.data.document_footer).toEqual(FOOTER);
        expect(await stored()).toEqual(FOOTER);

        const list = await admin.get('/campuses');
        expect(list.body.data.find((c: { id: number }) => c.id === CAMPUS_A).document_footer).toEqual(FOOTER);

        const audit = await prisma.audit_logs.findFirst({ where: { entity_type: 'CAMPUS', entity_id: String(CAMPUS_A), action: 'UPDATED' }, orderBy: { id: 'desc' } });
        expect(audit?.new_value).toBe(FOOTER.join(' / '));
    });

    it.each([
        ['a line too wide to fit even at the smallest size', ['W'.repeat(120)]],
        ['a fourth line', [...FOOTER, 'One line too many']],
        ['a character the fonts cannot print', ['☎ 3461-2878']],
    ])('refuses %s and keeps the saved footer', async (_what, lines) => {
        const res = await admin.put(`/campuses/${CAMPUS_A}/document-footer`).send({ lines });
        expect(res.status).toBe(400);
        expect(await stored()).toEqual(FOOTER);
    });

    it("previews an unsaved draft, without saving it, with each document's strip", async () => {
        const res = await admin.post(`/campuses/${CAMPUS_A}/document-footer/preview`).send({ lines: ['C-22, Block - I, North Nazimabad', ''] });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ lines: ['C-22, Block - I, North Nazimabad'], max_lines: 3, max_chars: 160, problems: [] });
        expect(res.body.data.areas.map((a: { id: string }) => a.id)).toEqual(['EXAM_DOCUMENT', 'LEAVING_CERTIFICATE']);
        for (const a of res.body.data.areas) {
            expect(a).toMatchObject({ source: 'CAMPUS_FOOTER', fits: true });
            expect(a.lines).toEqual([expect.objectContaining({ text: 'C-22, Block - I, North Nazimabad', shrunk: false, overflow: false })]);
            expect(typeof a.pdf_base64).toBe('string');
        }
        expect(await stored()).toEqual(FOOTER);
    });

    it('names what is wrong with a draft that cannot be saved', async () => {
        const res = await admin.post(`/campuses/${CAMPUS_A}/document-footer/preview`).send({ lines: ['W'.repeat(120)] });
        expect(res.status).toBe(200);
        expect(res.body.data.problems.join(' ')).toMatch(/too long/);
        expect(res.body.data.areas.every((a: { fits: boolean }) => !a.fits)).toBe(true);
    });

    it("previews each document's own footer when the draft is empty", async () => {
        const res = await admin.post(`/campuses/${CAMPUS_A}/document-footer/preview`).send({ lines: [] });
        expect(res.status).toBe(200);
        const [exam, slc] = res.body.data.areas;
        expect(exam.source).toBe('DOCUMENT_DEFAULT');
        // No address or UAN on the test campus: the web line alone.
        expect(exam.lines.map((l: { text: string }) => l.text)).toEqual(['info@tafs.edu.pk  ·  american@cyber.net.pk  ·  www.tafs.edu.pk']);
        expect(slc).toMatchObject({ source: 'DOCUMENT_DEFAULT', lines: [] });
    });

    it('clears the footer with no lines', async () => {
        const res = await admin.put(`/campuses/${CAMPUS_A}/document-footer`).send({ lines: ['', '  '] });
        expect(res.status).toBe(200);
        expect(await stored()).toEqual([]);
    });

    it('is closed to a caller without the Campuses edit action', async () => {
        const clerk = client(app, tokenFor(jwt, USERS.clerk));
        expect((await clerk.put(`/campuses/${CAMPUS_A}/document-footer`).send({ lines: FOOTER })).status).toBe(403);
        expect((await clerk.post(`/campuses/${CAMPUS_A}/document-footer/preview`).send({ lines: FOOTER })).status).toBe(403);
        expect(await stored()).toEqual([]);
    });
});
