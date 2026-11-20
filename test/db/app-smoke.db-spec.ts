/**
 * App smoke test (TAFSD-532). Replaces test/app.e2e-spec.ts, the NestJS
 * starter file, which never ran: its jest config could not load the ESM-only
 * `uuid`, and it requested `/` without the `api/v1` prefix and with no
 * database.
 *
 * The whole AppModule boots against the throwaway database with the
 * production request pipeline, the unauthenticated routes answer, a staff
 * route refuses a request with no token, and errors use the standard envelope.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootApp } from './helpers/app';

let app: INestApplication;

beforeAll(async () => {
    ({ app } = await bootApp());
});

afterAll(async () => {
    await app?.close();
});

describe('app smoke', () => {
    it('GET /api/v1 answers', async () => {
        const res = await request(app.getHttpServer()).get('/api/v1');
        expect(res.status).toBe(200);
        expect(res.text).toBe('Hello World!');
    });

    it('GET /api/v1/healthz answers without touching auth', async () => {
        const res = await request(app.getHttpServer()).get('/api/v1/healthz');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(Number.isNaN(Date.parse(res.body.ts))).toBe(false);
    });

    it('a route outside the api/v1 prefix is not served', async () => {
        const res = await request(app.getHttpServer()).get('/healthz');
        expect(res.status).toBe(404);
    });

    it('a staff route refuses a request with no token, in the standard error envelope', async () => {
        const res = await request(app.getHttpServer()).get('/api/v1/student-fees/caution-fee-history/1');
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ status: 401, data: null });
    });
});
