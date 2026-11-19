/**
 * Admin MCP server (TAFSD-531), end to end over HTTP against a real Postgres:
 * OAuth 2.1 discovery, dynamic client registration, authorize + consent,
 * the authorization-code exchange with PKCE, refresh-token rotation and reuse
 * detection, revocation, and that both OAuth and personal tokens reach the MCP
 * endpoint with the same per-route tool filtering and campus scope.
 *
 * Users (fixtures): `clerk` is scoped to campus A and is given the AI
 * Assistant and Student Directory tiles here; `viewer` gets Student Directory
 * but not the AI Assistant tile.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import request from 'supertest';
import type { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../../src/modules/access/access.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { STUDENT, USERS, seedSchool } from './helpers/fixtures';

const WEBAPP = 'http://webapp.test';
const REDIRECT = 'http://localhost:4567/callback';

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let as: { clerk: ReturnType<typeof client>; viewer: ReturnType<typeof client> };

const server = () => app.getHttpServer();

function pkce() {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

let registrations = 0;
async function register(redirectUris: string[] = [REDIRECT], extra: Record<string, unknown> = {}) {
    // A distinct client address each time: registration is rate-limited per address.
    registrations++;
    return request(server())
        .post('/api/v1/mcp/oauth/register')
        .set('X-Forwarded-For', `10.0.${Math.floor(registrations / 250)}.${registrations % 250}`)
        .send({ client_name: 'DB Suite Client', redirect_uris: redirectUris, ...extra });
}

/** /authorize → the webapp consent page; returns the signed ticket. */
async function startAuthorize(clientId: string, challenge: string, state = 'state-123') {
    const res = await request(server())
        .get('/api/v1/mcp/oauth/authorize')
        .query({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: REDIRECT,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state,
            scope: 'mcp',
        });
    expect(res.status).toBe(302);
    expect(res.headers.location.startsWith(`${WEBAPP}/mcp/authorize?ticket=`)).toBe(true);
    return new URL(res.headers.location).searchParams.get('ticket')!;
}

/** The issuer as discovery reports it: what every authorization response must carry (RFC 9207). */
async function issuer() {
    return (await request(server()).get('/.well-known/oauth-authorization-server')).body.issuer as string;
}

async function approve(who: ReturnType<typeof client>, ticket: string) {
    // The consent call reaches the backend through the webapp's /api proxy,
    // so its host is the webapp's. The `iss` sent back must still be ours.
    const res = await who
        .post('/mcp/oauth/consent')
        .set('Origin', WEBAPP)
        .set('X-Forwarded-Host', 'webapp.test')
        .send({ ticket, decision: 'approve' });
    expect(res.status).toBe(201);
    const back = new URL(res.body.data.redirect_to);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('state-123');
    expect(back.searchParams.get('iss')).toBe(await issuer());
    return back.searchParams.get('code')!;
}

const token = (body: Record<string, string>) =>
    request(server()).post('/api/v1/mcp/oauth/token').type('form').send(body);

const exchange = (clientId: string, code: string, verifier: string) =>
    token({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });

const refresh = (clientId: string, refreshToken: string) =>
    token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken });

function mcp(bearer: string, method: string, params: Record<string, unknown> = {}) {
    return request(server())
        .post('/api/v1/mcp')
        .set('Authorization', `Bearer ${bearer}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method, params });
}

const toolNames = async (bearer: string) => {
    const res = await mcp(bearer, 'tools/list');
    expect(res.status).toBe(200);
    return (res.body.result.tools as { name: string }[]).map((t) => t.name).sort();
};

/** A full sign-in for `clerk`: register, authorize, approve, exchange. */
async function connectClerk() {
    const reg = await register();
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = pkce();
    const code = await approve(as.clerk, await startAuthorize(clientId, challenge));
    const res = await exchange(clientId, code, verifier);
    expect(res.status).toBe(200);
    return { clientId, code, verifier, tokens: res.body as { access_token: string; refresh_token: string; expires_in: number } };
}

beforeAll(async () => {
    process.env.WEBAPP_URL = WEBAPP;
    delete process.env.MCP_PUBLIC_URL;
    delete process.env.MCP_OAUTH_REDIRECT_HOSTS;
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
    const grant = (userId: string, tileId: string) =>
        prisma.user_tile_grants.create({ data: { user_id: userId, tile_id: tileId, allow: true, granted_by: USERS.admin.id } });
    await grant(USERS.clerk.id, 'system.ai_assistant');
    await grant(USERS.clerk.id, 'student.directory');
    await grant(USERS.viewer.id, 'student.directory');
    app.get(AccessService).invalidateLiveSession();
    as = { clerk: client(app, tokenFor(jwt, USERS.clerk)), viewer: client(app, tokenFor(jwt, USERS.viewer)) };
});

afterAll(async () => {
    await app?.close();
});

describe('discovery', () => {
    it('answers an unauthenticated MCP call with a 401 that points at the resource metadata', async () => {
        const res = await request(server()).post('/api/v1/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toMatch(
            /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/api\/v1\/mcp"$/,
        );
    });

    it('serves protected-resource and authorization-server metadata at the origin root', async () => {
        const prm = await request(server()).get('/.well-known/oauth-protected-resource/api/v1/mcp');
        expect(prm.status).toBe(200);
        expect(prm.body.resource).toMatch(/\/api\/v1\/mcp$/);
        const issuer = prm.body.authorization_servers[0];

        const asm = await request(server()).get('/.well-known/oauth-authorization-server');
        expect(asm.status).toBe(200);
        expect(asm.body).toMatchObject({
            issuer,
            authorization_endpoint: `${issuer}/api/v1/mcp/oauth/authorize`,
            token_endpoint: `${issuer}/api/v1/mcp/oauth/token`,
            registration_endpoint: `${issuer}/api/v1/mcp/oauth/register`,
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
        });
        expect((await request(server()).get('/.well-known/oauth-protected-resource')).status).toBe(200);
    });
});

describe('issuer in production', () => {
    const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
        const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
        Object.assign(process.env, env);
        for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
        try {
            await fn();
        } finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    };

    it('turns OAuth off rather than trusting request headers when MCP_PUBLIC_URL is missing', () =>
        withEnv({ NODE_ENV: 'production', MCP_PUBLIC_URL: undefined }, async () => {
            const meta = await request(server()).get('/.well-known/oauth-authorization-server').set('X-Forwarded-Host', 'evil.example');
            expect(meta.status).toBe(503);
            const unauth = await request(server()).post('/api/v1/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
            expect(unauth.status).toBe(401);
            expect(unauth.headers['www-authenticate']).toBe('Bearer');
            const auth = await request(server())
                .get('/api/v1/mcp/oauth/authorize')
                .query({ response_type: 'code', client_id: (await register()).body.client_id, redirect_uri: REDIRECT });
            expect(auth.status).toBe(503);
            expect(auth.headers.location).toBeUndefined();
        }));

    it('tells the webapp the public MCP address, not the host the request came in on', () =>
        withEnv({ NODE_ENV: 'production', MCP_PUBLIC_URL: 'https://api.tafs.example/' }, async () => {
            const res = await as.clerk.get('/mcp/tokens/server').set('X-Forwarded-Host', 'internal.example');
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ endpoint: 'https://api.tafs.example/api/v1/mcp', sign_in_available: true });
        }));

    it('reports no address when sign-in is not configured in production', () =>
        withEnv({ NODE_ENV: 'production', MCP_PUBLIC_URL: undefined }, async () => {
            const res = await as.clerk.get('/mcp/tokens/server');
            expect(res.status).toBe(200);
            expect(res.body.data).toEqual({ endpoint: null, sign_in_available: false });
        }));

    it('names MCP_PUBLIC_URL as issuer whatever the request says, and is never cached across hosts', () =>
        withEnv({ NODE_ENV: 'production', MCP_PUBLIC_URL: 'https://api.tafs.example/' }, async () => {
            const meta = await request(server()).get('/.well-known/oauth-authorization-server').set('X-Forwarded-Host', 'evil.example');
            expect(meta.status).toBe(200);
            expect(meta.body.issuer).toBe('https://api.tafs.example');
            expect(meta.headers['cache-control']).toBe('no-store');
            const unauth = await request(server()).post('/api/v1/mcp').set('X-Forwarded-Host', 'evil.example').send({});
            expect(unauth.headers['www-authenticate']).toBe(
                'Bearer resource_metadata="https://api.tafs.example/.well-known/oauth-protected-resource/api/v1/mcp"',
            );
        }));
});

describe('dynamic client registration', () => {
    it('registers a public loopback client', async () => {
        const res = await register();
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ token_endpoint_auth_method: 'none', redirect_uris: [REDIRECT] });
        expect(res.body.client_id).toMatch(/^tafs_mcp_client_/);
        expect(res.body.client_secret).toBeUndefined();
    });

    it('refuses a redirect to a host that is not allowed', async () => {
        const res = await register(['https://evil.example/cb']);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_redirect_uri');
    });

    it('allows only the exact claude.ai connector callback among https redirects', async () => {
        expect((await register(['https://claude.ai/api/mcp/auth_callback'])).status).toBe(201);
        for (const uri of ['https://claude.ai/other', 'https://evil.claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback/x']) {
            const res = await register([uri]);
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('invalid_redirect_uri');
        }
    });

    it('limits registrations per client address', async () => {
        const from = (n: number) =>
            request(server())
                .post('/api/v1/mcp/oauth/register')
                .set('X-Forwarded-For', '192.0.2.77')
                .send({ client_name: `burst ${n}`, redirect_uris: [REDIRECT] });
        for (let i = 0; i < 20; i++) expect((await from(i)).status).toBe(201);
        const over = await from(20);
        expect(over.status).toBe(429);
    });

    it('registers a client that asks for a secret as a public client, issuing no secret (TAFSD-540)', async () => {
        for (const method of ['client_secret_basic', 'client_secret_post']) {
            const res = await register([REDIRECT], { token_endpoint_auth_method: method });
            expect(res.status).toBe(201);
            expect(res.body.token_endpoint_auth_method).toBe('none');
            expect(res.body.client_secret).toBeUndefined();
        }
    });

    it('still refuses an auth method it cannot honour', async () => {
        const res = await register([REDIRECT], { token_endpoint_auth_method: 'private_key_jwt' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_client_metadata');
    });

    it('accepts ChatGPT\'s connector callback by default (TAFSD-540)', async () => {
        const res = await register(['https://chatgpt.com/connector_platform_oauth_redirect']);
        expect(res.status).toBe(201);
    });
});

describe('authorize', () => {
    it('shows an error page, never a redirect, for an unknown client', async () => {
        const res = await request(server())
            .get('/api/v1/mcp/oauth/authorize')
            .query({ response_type: 'code', client_id: 'nope', redirect_uri: REDIRECT });
        expect(res.status).toBe(400);
        expect(res.headers.location).toBeUndefined();
    });

    it('refuses an unregistered redirect URI without redirecting to it', async () => {
        const clientId = (await register()).body.client_id;
        const res = await request(server())
            .get('/api/v1/mcp/oauth/authorize')
            .query({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:4567/other' });
        expect(res.status).toBe(400);
        expect(res.headers.location).toBeUndefined();
    });

    it('sends PKCE "plain" back to the client as an error', async () => {
        const clientId = (await register()).body.client_id;
        const res = await request(server())
            .get('/api/v1/mcp/oauth/authorize')
            .query({
                response_type: 'code',
                client_id: clientId,
                redirect_uri: REDIRECT,
                code_challenge: 'x'.repeat(43),
                code_challenge_method: 'plain',
                state: 's1',
            });
        expect(res.status).toBe(302);
        const back = new URL(res.headers.location);
        expect(back.searchParams.get('error')).toBe('invalid_request');
        expect(back.searchParams.get('state')).toBe('s1');
    });
});

describe('consent', () => {
    it('shows the client, the person and exactly their tools', async () => {
        const clientId = (await register()).body.client_id;
        const ticket = await startAuthorize(clientId, pkce().challenge);
        const res = await as.clerk.get(`/mcp/oauth/consent?ticket=${encodeURIComponent(ticket)}`);
        expect(res.status).toBe(200);
        const d = res.body.data;
        expect(d).toMatchObject({
            client: { name: 'DB Suite Client', name_verified: false, redirect_host: 'localhost:4567' },
            acting_as: { username: USERS.clerk.username },
            allowed: true,
            blocked_reason: null,
        });
        const names = d.tools.map((t: { name: string }) => t.name).sort();
        expect(names).toEqual(['get_student', 'search_students', 'whoami']);
    });

    it('lets a person without the AI Assistant tile only deny', async () => {
        const clientId = (await register()).body.client_id;
        const ticket = await startAuthorize(clientId, pkce().challenge);
        const shown = await as.viewer.get(`/mcp/oauth/consent?ticket=${encodeURIComponent(ticket)}`);
        expect(shown.body.data).toMatchObject({ allowed: false, blocked_reason: 'no_tile', tools: [] });
        const approve = await as.viewer.post('/mcp/oauth/consent').set('Origin', WEBAPP).send({ ticket, decision: 'approve' });
        expect(approve.status).toBe(403);
        expect(await prisma.mcp_oauth_codes.count({ where: { user_id: USERS.viewer.id } })).toBe(0);
    });

    it('sends a denial back as access_denied and issues no code', async () => {
        const clientId = (await register()).body.client_id;
        const ticket = await startAuthorize(clientId, pkce().challenge);
        const res = await as.clerk
            .post('/mcp/oauth/consent')
            .set('Origin', WEBAPP)
            .set('X-Forwarded-Host', 'webapp.test')
            .send({ ticket, decision: 'deny' });
        expect(res.status).toBe(201);
        const back = new URL(res.body.data.redirect_to);
        expect(back.searchParams.get('error')).toBe('access_denied');
        expect(back.searchParams.get('iss')).toBe(await issuer());
        expect(back.searchParams.get('state')).toBe('state-123');
        expect(back.searchParams.get('code')).toBeNull();
        expect(await prisma.mcp_oauth_codes.count({ where: { client_id: clientId } })).toBe(0);
    });

    it('refuses a forged or tampered ticket', async () => {
        const res = await as.clerk
            .post('/mcp/oauth/consent')
            .set('Origin', WEBAPP)
            .send({ ticket: 'not.a.ticket', decision: 'approve' });
        expect(res.status).toBe(404);
    });
});

describe('consent cannot be forged from another site (CSRF)', () => {
    const consentFor = async () => startAuthorize((await register()).body.client_id, pkce().challenge);
    const noCodes = async () => expect(await prisma.mcp_oauth_codes.count({ where: { user_id: USERS.clerk.id, used_at: null } })).toBe(0);

    beforeEach(async () => {
        await prisma.mcp_oauth_codes.deleteMany({ where: { user_id: USERS.clerk.id, used_at: null } });
    });

    it('refuses an approval with no Origin', async () => {
        const ticket = await consentFor();
        const res = await as.clerk.post('/mcp/oauth/consent').send({ ticket, decision: 'approve' });
        expect(res.status).toBe(403);
        await noCodes();
    });

    it('refuses an approval from another origin, even this project’s own previews', async () => {
        for (const origin of ['https://evil.vercel.app', 'https://tafs-webapp-abc123xyz-tafstechsystems-1600s-projects.vercel.app', 'http://localhost:9999']) {
            const res = await as.clerk.post('/mcp/oauth/consent').set('Origin', origin).send({ ticket: await consentFor(), decision: 'approve' });
            expect(res.status).toBe(403);
        }
        await noCodes();
    });

    it('refuses to describe a consent to another origin or a cross-site request', async () => {
        const ticket = await consentFor();
        const q = `/mcp/oauth/consent?ticket=${encodeURIComponent(ticket)}`;
        expect((await as.clerk.get(q).set('Origin', 'https://evil.vercel.app')).status).toBe(403);
        expect((await as.clerk.get(q).set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
        expect((await as.clerk.get(q).set('Sec-Fetch-Site', 'same-origin')).status).toBe(200);
    });

    it('binds a ticket to the first person who opens it', async () => {
        const ticket = await consentFor();
        expect((await as.clerk.get(`/mcp/oauth/consent?ticket=${encodeURIComponent(ticket)}`)).status).toBe(200);
        const admin = client(app, tokenFor(jwt, USERS.admin));
        const stolen = await admin.post('/mcp/oauth/consent').set('Origin', WEBAPP).send({ ticket, decision: 'approve' });
        expect(stolen.status).toBe(404);
        expect((await admin.get(`/mcp/oauth/consent?ticket=${encodeURIComponent(ticket)}`)).status).toBe(404);
        // Its owner can still answer it.
        expect((await as.clerk.post('/mcp/oauth/consent').set('Origin', WEBAPP).send({ ticket, decision: 'approve' })).status).toBe(201);
    });

    it('takes one answer per ticket', async () => {
        const ticket = await consentFor();
        const answer = (decision: string) => as.clerk.post('/mcp/oauth/consent').set('Origin', WEBAPP).send({ ticket, decision });
        expect((await answer('approve')).status).toBe(201);
        expect((await answer('approve')).status).toBe(404);
        expect((await answer('deny')).status).toBe(404);
        expect(await prisma.mcp_oauth_codes.count({ where: { user_id: USERS.clerk.id, used_at: null } })).toBe(1);
    });
});

describe('token exchange (PKCE)', () => {
    it('refuses a wrong verifier, then accepts the right one once', async () => {
        const clientId = (await register()).body.client_id;
        const { verifier, challenge } = pkce();
        const code = await approve(as.clerk, await startAuthorize(clientId, challenge));

        const wrong = await exchange(clientId, code, pkce().verifier);
        expect(wrong.status).toBe(400);
        expect(wrong.body.error).toBe('invalid_grant');

        const ok = await exchange(clientId, code, verifier);
        expect(ok.status).toBe(200);
        expect(ok.headers['cache-control']).toBe('no-store');
        expect(ok.body).toMatchObject({ token_type: 'Bearer', scope: 'mcp', expires_in: 3600 });
        expect(ok.body.access_token).toMatch(/^tafs_oat_/);
        expect(ok.body.refresh_token).toMatch(/^tafs_ort_/);
    });

    it('refuses the code from another client or with another redirect URI', async () => {
        const clientId = (await register()).body.client_id;
        const other = (await register()).body.client_id;
        const { verifier, challenge } = pkce();
        const code = await approve(as.clerk, await startAuthorize(clientId, challenge));
        expect((await exchange(other, code, verifier)).body.error).toBe('invalid_grant');
        const badRedirect = await token({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            code_verifier: verifier,
            redirect_uri: 'http://localhost:4567/elsewhere',
        });
        expect(badRedirect.body.error).toBe('invalid_grant');
    });

    it('lets exactly one of two simultaneous redemptions win, and then revokes it', async () => {
        const clientId = (await register()).body.client_id;
        const { verifier, challenge } = pkce();
        const code = await approve(as.clerk, await startAuthorize(clientId, challenge));
        const results = await Promise.all([exchange(clientId, code, verifier), exchange(clientId, code, verifier)]);
        const statuses = results.map((r) => r.status).sort();
        expect(statuses).toEqual([200, 400]);
        const winner = results.find((r) => r.status === 200)!.body;
        // The loser's replay revoked the grant the winner received.
        expect((await mcp(winner.access_token, 'tools/list')).status).toBe(401);
        const grant = await prisma.mcp_oauth_grants.findFirst({ where: { client_id: clientId } });
        expect(grant?.revoked_reason).toBe('code_reuse');
    });

    it('revokes the grant when a used code is replayed', async () => {
        const { clientId, code, verifier, tokens } = await connectClerk();
        expect((await mcp(tokens.access_token, 'tools/list')).status).toBe(200);
        const replay = await exchange(clientId, code, verifier);
        expect(replay.body.error).toBe('invalid_grant');
        expect((await mcp(tokens.access_token, 'tools/list')).status).toBe(401);
        expect((await refresh(clientId, tokens.refresh_token)).body.error).toBe('invalid_grant');
    });

    it('stores no token in clear', async () => {
        const { tokens } = await connectClerk();
        const leaked = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM mcp_access_tokens WHERE token_hash = $1 OR token_prefix = $1
             UNION ALL SELECT count(*)::bigint FROM mcp_oauth_refresh_tokens WHERE token_hash = $2`,
            tokens.access_token,
            tokens.refresh_token,
        );
        expect(leaked.map((r) => Number(r.n))).toEqual([0, 0]);
    });
});

describe('the MCP endpoint with an OAuth token', () => {
    it('lists the same tools as the consent screen and keeps campus scope', async () => {
        const { tokens } = await connectClerk();
        expect(await toolNames(tokens.access_token)).toEqual(['get_student', 'search_students', 'whoami']);

        const search = await mcp(tokens.access_token, 'tools/call', { name: 'search_students', arguments: { q: 'Test Student' } });
        const ccs = JSON.parse(search.body.result.content[0].text).map((s: { cc: number }) => s.cc).sort();
        expect(ccs).toEqual([STUDENT.A1, STUDENT.A2, STUDENT.A_APR].sort());

        const outOfScope = await mcp(tokens.access_token, 'tools/call', { name: 'get_student', arguments: { cc: STUDENT.B1 } });
        expect(outOfScope.body.result.isError).toBe(true);

        const audit = await prisma.audit_logs.findFirst({
            where: { entity_type: 'MCP_TOOL', entity_id: 'search_students' },
            orderBy: { id: 'desc' },
        });
        expect(audit?.note).toMatch(/· oauth grant [0-9a-f-]{36}$/);
    });

    it('keeps personal access tokens working alongside', async () => {
        const issued = await as.clerk.post('/mcp/tokens').send({ name: 'DB suite PAT' });
        expect(issued.status).toBe(201);
        expect(await toolNames(issued.body.data.token)).toEqual(['get_student', 'search_students', 'whoami']);
        const listed = await as.clerk.get('/mcp/tokens');
        // OAuth access tokens are not personal tokens and are not listed as such.
        expect(listed.body.data.every((t: { name: string }) => t.name === 'DB suite PAT')).toBe(true);
    });
});

describe('refresh tokens rotate', () => {
    it('issues a new pair and retires the old refresh token', async () => {
        const { clientId, tokens } = await connectClerk();
        const next = await refresh(clientId, tokens.refresh_token);
        expect(next.status).toBe(200);
        expect(next.body.refresh_token).not.toBe(tokens.refresh_token);
        expect(next.body.access_token).not.toBe(tokens.access_token);
        expect(await toolNames(next.body.access_token)).toContain('search_students');
    });

    it('revokes the whole grant when a used refresh token is replayed', async () => {
        const { clientId, tokens } = await connectClerk();
        const next = (await refresh(clientId, tokens.refresh_token)).body;
        const replay = await refresh(clientId, tokens.refresh_token);
        expect(replay.status).toBe(400);
        expect(replay.body.error).toBe('invalid_grant');
        // The thief's replay also cut off the legitimate holder of the new pair.
        expect((await mcp(next.access_token, 'tools/list')).status).toBe(401);
        expect((await refresh(clientId, next.refresh_token)).body.error).toBe('invalid_grant');
        const grant = await prisma.mcp_oauth_grants.findFirst({ where: { client_id: clientId } });
        expect(grant?.revoked_reason).toBe('refresh_reuse');
    });

    it('refuses a refresh token presented by another client', async () => {
        const { tokens } = await connectClerk();
        const other = (await register()).body.client_id;
        expect((await refresh(other, tokens.refresh_token)).body.error).toBe('invalid_grant');
    });
});

describe('revocation', () => {
    it('a person revokes a connected app from the AI Assistant page', async () => {
        const { clientId, tokens } = await connectClerk();
        const listed = await as.clerk.get('/mcp/grants');
        const grant = listed.body.data.find((g: { client_id: string }) => g.client_id === clientId);
        expect(grant).toMatchObject({ client_name: 'DB Suite Client', status: 'active', redirect_hosts: ['localhost:4567'] });

        const revoked = await as.clerk.delete(`/mcp/grants/${grant.id}`);
        expect(revoked.status).toBe(200);
        expect(revoked.body.data.status).toBe('revoked');
        expect((await mcp(tokens.access_token, 'tools/list')).status).toBe(401);
        expect((await refresh(clientId, tokens.refresh_token)).body.error).toBe('invalid_grant');
    });

    it('cannot see or revoke someone else’s connection', async () => {
        await connectClerk();
        const grant = await prisma.mcp_oauth_grants.findFirst({ where: { user_id: USERS.clerk.id, revoked_at: null } });
        const res = await client(app, tokenFor(jwt, USERS.admin)).delete(`/mcp/grants/${grant!.id}`);
        expect(res.status).toBe(404);
    });

    it('the client can revoke its own grant (RFC 7009)', async () => {
        const { tokens } = await connectClerk();
        const res = await request(server()).post('/api/v1/mcp/oauth/revoke').type('form').send({ token: tokens.refresh_token });
        expect(res.status).toBe(200);
        expect((await mcp(tokens.access_token, 'tools/list')).status).toBe(401);
    });

    it('losing the AI Assistant tile stops access and refresh', async () => {
        const { clientId, tokens } = await connectClerk();
        await prisma.user_tile_grants.deleteMany({ where: { user_id: USERS.clerk.id, tile_id: 'system.ai_assistant' } });
        app.get(AccessService).invalidateLiveSession();
        try {
            expect((await mcp(tokens.access_token, 'tools/list')).status).toBe(403);
            expect((await refresh(clientId, tokens.refresh_token)).body.error).toBe('invalid_grant');
        } finally {
            await prisma.user_tile_grants.create({
                data: { user_id: USERS.clerk.id, tile_id: 'system.ai_assistant', allow: true, granted_by: USERS.admin.id },
            });
            app.get(AccessService).invalidateLiveSession();
        }
    });
});

describe('audit', () => {
    it('records approve, deny, issue, refresh and revoke, with no secret in any row', async () => {
        const rows = await prisma.audit_logs.findMany({ where: { entity_type: 'MCP_OAUTH' } });
        const actions = new Set(rows.map((r) => r.action));
        for (const a of ['CLIENT_REGISTER', 'CONSENT_APPROVE', 'CONSENT_DENY', 'TOKEN_ISSUE', 'TOKEN_REFRESH', 'GRANT_REVOKE']) {
            expect(actions).toContain(a);
        }
        const text = JSON.stringify(await prisma.audit_logs.findMany());
        expect(text).not.toMatch(/tafs_(oat|ort|oac|pat)_[A-Za-z0-9_-]{20}/);
    });
});
