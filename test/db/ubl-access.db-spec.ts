/**
 * TAFSD-548: the UBL IP allow-list and rate limit sit on the two bank-facing
 * routes only, and answer before body validation and the credential check.
 * The middleware reads its env at startup, so it is set before the app boots.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootApp } from './helpers/app';

let app: INestApplication;
const saved = { allowed: process.env.UBL_ALLOWED_IPS, limit: process.env.UBL_RATE_LIMIT_PER_MINUTE };

beforeAll(async () => {
    process.env.UBL_ALLOWED_IPS = '203.0.113.0/24';
    process.env.UBL_RATE_LIMIT_PER_MINUTE = '5';
    ({ app } = await bootApp());
});

afterAll(async () => {
    await app?.close();
    if (saved.allowed === undefined) delete process.env.UBL_ALLOWED_IPS;
    else process.env.UBL_ALLOWED_IPS = saved.allowed;
    if (saved.limit === undefined) delete process.env.UBL_RATE_LIMIT_PER_MINUTE;
    else process.env.UBL_RATE_LIMIT_PER_MINUTE = saved.limit;
});

const viaCloudflare = (ip: string) => ({ 'do-connecting-ip': '104.16.0.1', 'cf-connecting-ip': ip });

describe('UBL network controls over HTTP', () => {
    it('refuses an address outside the allow-list on both routes, before validation runs', async () => {
        const inquiry = await request(app.getHttpServer()).get('/api/v1/ubl/bill-inquiry?consumer_number=44');
        expect(inquiry.status).toBe(403);
        expect(inquiry.body).toMatchObject({ response_code: '10', response_desc: 'Requests from this address are not allowed' });

        // An invalid body would be a 400 from validation; the allow-list answers first.
        const payment = await request(app.getHttpServer()).post('/api/v1/ubl/bill-payment').send({ junk: true });
        expect(payment.status).toBe(403);
    });

    it('ignores a Cloudflare client header that did not come from Cloudflare', async () => {
        const res = await request(app.getHttpServer())
            .get('/api/v1/ubl/bill-inquiry?consumer_number=44')
            .set('cf-connecting-ip', '203.0.113.7');
        expect(res.status).toBe(403);
    });

    it('lets an allow-listed client through to the credential check', async () => {
        const res = await request(app.getHttpServer())
            .get('/api/v1/ubl/bill-inquiry?consumer_number=44')
            .set(viaCloudflare('203.0.113.8'));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ response_code: '10', response_desc: 'Invalid credentials' });
    });

    it('rate-limits an allow-listed client per minute', async () => {
        const hit = () => request(app.getHttpServer()).get('/api/v1/ubl/bill-inquiry?consumer_number=44').set(viaCloudflare('203.0.113.9'));
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) statuses.push((await hit()).status);
        expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
        const last = await hit();
        expect(last.status).toBe(429);
        expect(last.body.response_code).toBe('99');
    });

    it('does not touch the staff UBL reconciliation reports', async () => {
        const res = await request(app.getHttpServer()).get('/api/v1/financial-reports/ubl/reconciliation');
        expect(res.status).not.toBe(403);
        expect(res.body?.response_code).toBeUndefined();
    });
});
