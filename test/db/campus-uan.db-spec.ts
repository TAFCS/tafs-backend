/**
 * TAFSD-549: a campus's UAN number is set and cleared through Setup → Campuses
 * (PATCH /campuses/bulk) and on a new campus (POST /campuses), comes back on the
 * campus list, and is audit-logged like the other campus fields.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, USERS, seedSchool } from './helpers/fixtures';

let app: INestApplication;
let prisma: PrismaService;
let admin: ReturnType<typeof client>;

beforeAll(async () => {
    let jwt: JwtService;
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    admin = client(app, tokenFor(jwt, USERS.admin));
});

afterAll(async () => {
    await app?.close();
});

describe('campus UAN number', () => {
    it('is set, shown and cleared through the campus settings, with an audit note', async () => {
        const set = await admin.patch('/campuses/bulk').send({ items: [{ id: CAMPUS_A, uan_number: ' 111-823-723 ' }] });
        expect(set.status).toBeLessThan(300);
        expect((await prisma.campuses.findUniqueOrThrow({ where: { id: CAMPUS_A } })).uan_number).toBe('111-823-723');

        const list = await admin.get('/campuses');
        const rows = list.body.data?.items ?? list.body.data;
        expect(rows.find((c: any) => c.id === CAMPUS_A).uan_number).toBe('111-823-723');

        const audit = await prisma.audit_logs.findFirst({ where: { entity_type: 'CAMPUS', entity_id: String(CAMPUS_A) }, orderBy: { id: 'desc' } });
        expect(audit?.note).toContain('UAN "—" → "111-823-723"');

        await admin.patch('/campuses/bulk').send({ items: [{ id: CAMPUS_A, uan_number: '' }] });
        expect((await prisma.campuses.findUniqueOrThrow({ where: { id: CAMPUS_A } })).uan_number).toBeNull();
    });

    it('refuses a UAN not written as 111-XXX-XXX', async () => {
        for (const bad of ['111823723', '021-111-823-723', '111-82-3723', 'abc']) {
            const res = await admin.patch('/campuses/bulk').send({ items: [{ id: CAMPUS_A, uan_number: bad }] });
            expect(res.status).toBe(400);
        }
        const res = await admin.post('/campuses').send({ campus_code: 'TX', campus_name: 'Bad UAN', uan_number: '123-456-789' });
        expect(res.status).toBe(400);
    });

    it('is saved on a new campus', async () => {
        const res = await admin.post('/campuses').send({ campus_code: 'TC', campus_name: 'Test Campus C', uan_number: '111-000-111' });
        expect(res.status).toBeLessThan(300);
        expect((await prisma.campuses.findUniqueOrThrow({ where: { campus_code: 'TC' } })).uan_number).toBe('111-000-111');
    });
});
