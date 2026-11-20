import { CLOUDFLARE_RANGES, PerMinuteLimiter, clientIpOf, ipInList, normalizeIp, parseIpList, rateLimitFromEnv } from './ubl-access';
import { UblAccessMiddleware } from './ubl-access.middleware';

const CF = parseIpList(CLOUDFLARE_RANGES.join(','))!;

describe('UBL network controls (TAFSD-548)', () => {
    describe('parseIpList', () => {
        it('treats an unset or empty list as no restriction', () => {
            expect(parseIpList(undefined)).toBeNull();
            expect(parseIpList('  , ')).toBeNull();
        });
        it('matches single addresses and CIDR ranges, IPv4 and IPv6', () => {
            const list = parseIpList('203.0.113.7, 198.51.100.0/24, 2001:db8::/32')!;
            expect(ipInList(list, '203.0.113.7')).toBe(true);
            expect(ipInList(list, '203.0.113.8')).toBe(false);
            expect(ipInList(list, '198.51.100.250')).toBe(true);
            expect(ipInList(list, '198.51.101.1')).toBe(false);
            expect(ipInList(list, '2001:db8:1::5')).toBe(true);
            expect(ipInList(list, '2001:db9::1')).toBe(false);
        });
        it.each(['not-an-ip', '1.2.3.4/33', '1.2.3/24', '10.0.0.0/x'])('rejects a bad entry: %s', (bad) =>
            expect(() => parseIpList(`203.0.113.7, ${bad}`)).toThrow('Invalid IP or CIDR'),
        );
    });

    describe('clientIpOf', () => {
        it('uses the connecting peer when it is not Cloudflare, ignoring any client-sent Cloudflare header', () => {
            expect(clientIpOf({ 'cf-connecting-ip': '203.0.113.7' }, '::ffff:198.18.0.9', CF)).toBe('198.18.0.9');
            expect(clientIpOf({ 'do-connecting-ip': '198.18.0.9', 'cf-connecting-ip': '203.0.113.7' }, '10.0.0.1', CF)).toBe('198.18.0.9');
        });
        it('believes cf-connecting-ip only when the peer is a Cloudflare edge address', () => {
            expect(clientIpOf({ 'do-connecting-ip': '104.16.0.1', 'cf-connecting-ip': '203.0.113.7' }, '10.0.0.1', CF)).toBe('203.0.113.7');
            expect(clientIpOf({ 'do-connecting-ip': '2606:4700::1', 'cf-connecting-ip': '2001:db8::9' }, undefined, CF)).toBe('2001:db8::9');
        });
        it('never trusts x-forwarded-for', () => {
            expect(clientIpOf({ 'x-forwarded-for': '203.0.113.7' }, '198.18.0.9', CF)).toBe('198.18.0.9');
        });
        it('normalises IPv4-mapped addresses and rejects junk', () => {
            expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
            expect(normalizeIp('nonsense')).toBeNull();
        });
    });

    describe('PerMinuteLimiter', () => {
        it('allows up to the limit per key per minute, then refuses until the window resets', () => {
            let t = 0;
            const l = new PerMinuteLimiter(3, () => t);
            expect([l.take('a'), l.take('a'), l.take('a'), l.take('a')]).toEqual([true, true, true, false]);
            expect(l.take('b')).toBe(true);
            t = 60_000;
            expect(l.take('a')).toBe(true);
        });
        it('is off at 0', () => {
            const l = new PerMinuteLimiter(0);
            for (let i = 0; i < 1000; i++) expect(l.take('a')).toBe(true);
        });
        it('reads the limit from env with a default', () => {
            expect(rateLimitFromEnv(undefined)).toBe(600);
            expect(rateLimitFromEnv('120')).toBe(120);
            expect(rateLimitFromEnv('0')).toBe(0);
            expect(() => rateLimitFromEnv('-1')).toThrow();
            expect(() => rateLimitFromEnv('ten')).toThrow();
        });
    });

    describe('UblAccessMiddleware', () => {
        const saved = { ...process.env };
        afterEach(() => {
            process.env = { ...saved };
        });
        const run = (mw: UblAccessMiddleware, headers: Record<string, string>, socket = '198.18.0.9') => {
            const res: any = { statusCode: 200, headers: {} as Record<string, string> };
            res.status = (s: number) => ((res.statusCode = s), res);
            res.json = (b: unknown) => ((res.body = b), res);
            res.setHeader = (k: string, v: string) => (res.headers[k] = v);
            const next = jest.fn();
            mw.use({ headers, socket: { remoteAddress: socket }, method: 'GET', path: '/api/v1/ubl/bill-inquiry' } as any, res, next);
            return { res, next };
        };

        it('lets everything through when no allow-list is set (today\'s behaviour)', () => {
            delete process.env.UBL_ALLOWED_IPS;
            const { next } = run(new UblAccessMiddleware(), {});
            expect(next).toHaveBeenCalled();
        });

        it('refuses an address outside the allow-list with 403 and code 10, before anything else runs', () => {
            process.env.UBL_ALLOWED_IPS = '203.0.113.0/24';
            const { res, next } = run(new UblAccessMiddleware(), {});
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
            expect(res.body).toMatchObject({ response_code: '10', client_ip: '198.18.0.9' });
        });

        it('admits an allow-listed client arriving through Cloudflare', () => {
            process.env.UBL_ALLOWED_IPS = '203.0.113.0/24';
            const { next } = run(new UblAccessMiddleware(), { 'do-connecting-ip': '104.16.0.1', 'cf-connecting-ip': '203.0.113.7' });
            expect(next).toHaveBeenCalled();
        });

        it('is not fooled by a spoofed Cloudflare header sent straight to the origin', () => {
            process.env.UBL_ALLOWED_IPS = '203.0.113.0/24';
            const { res, next } = run(new UblAccessMiddleware(), { 'cf-connecting-ip': '203.0.113.7' });
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
        });

        it('rate-limits per client with 429, code 99 and Retry-After', () => {
            delete process.env.UBL_ALLOWED_IPS;
            process.env.UBL_RATE_LIMIT_PER_MINUTE = '2';
            const mw = new UblAccessMiddleware();
            expect(run(mw, {}).next).toHaveBeenCalled();
            expect(run(mw, {}).next).toHaveBeenCalled();
            const third = run(mw, {});
            expect(third.next).not.toHaveBeenCalled();
            expect(third.res.statusCode).toBe(429);
            expect(third.res.body).toMatchObject({ response_code: '99' });
            expect(third.res.headers['Retry-After']).toBe('60');
            expect(run(mw, {}, '198.18.0.10').next).toHaveBeenCalled(); // another client is unaffected
        });

        it('fails closed on a malformed allow-list instead of opening the API', () => {
            process.env.UBL_ALLOWED_IPS = '203.0.113.0/24, oops';
            const { res, next } = run(new UblAccessMiddleware(), {});
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(503);
        });
    });
});
