/**
 * TAFSD-614: the API Docs tile, through the real guards into a real Postgres.
 *
 * Covered: without a grant every route is refused, including the PDF; a
 * per-person tile grant opens the list, each document and its PDF; an unknown
 * document is a 404, not a file read.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { USERS, seedSchool } from './helpers/fixtures';

const TILE = 'system.api_docs';

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
});

afterAll(async () => {
    await app?.close();
});

describe('API Docs tile over HTTP', () => {
    it('refuses every route to someone without the tile', async () => {
        const clerk = client(app, tokenFor(jwt, USERS.clerk));
        for (const path of ['/api-docs', '/api-docs/ubl', '/api-docs/ubl/pdf', '/api-docs/attendance-machines/pdf']) {
            expect((await clerk.get(path)).status).toBe(403);
        }
    });

    it('opens the list, each document and its PDF once the tile is granted', async () => {
        await prisma.user_tile_grants.create({ data: { user_id: USERS.viewer.id, tile_id: TILE, allow: true, granted_by: USERS.admin.id } });
        const viewer = client(app, tokenFor(jwt, USERS.viewer));

        const list = await viewer.get('/api-docs');
        expect(list.status).toBe(200);
        expect(list.body.data.map((d: { slug: string }) => d.slug)).toEqual(['attendance-machines', 'ubl']);
        expect(list.body.data.every((d: { pdf_available: boolean }) => d.pdf_available)).toBe(true);

        const doc = await viewer.get('/api-docs/ubl');
        expect(doc.status).toBe(200);
        expect(doc.body.data.sections.length).toBeGreaterThan(0);

        const pdf = await viewer.get('/api-docs/ubl/pdf').buffer(true).parse((res, cb) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        expect(pdf.status).toBe(200);
        expect(pdf.headers['content-type']).toBe('application/pdf');
        expect(pdf.headers['content-disposition']).toContain('TAFS_API_UBL');
        expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('answers an unknown document with 404', async () => {
        const admin = client(app, tokenFor(jwt, USERS.admin));
        expect((await admin.get('/api-docs/../../package.json')).status).toBe(404);
        expect((await admin.get('/api-docs/nope')).status).toBe(404);
        expect((await admin.get('/api-docs/nope/pdf')).status).toBe(404);
    });
});
