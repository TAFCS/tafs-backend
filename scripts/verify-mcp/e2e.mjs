// TAFSD-531 end-to-end check of the admin MCP server. LOCAL ONLY.
//
// It writes to the database it is pointed at (tokens, tile grants, audit rows),
// so it refuses any database that is not on localhost. Never point it at the
// shared remote database.
//
// Setup (a private throwaway cluster; see README.md next to this file):
//   1. initdb + pg_ctl a cluster on a spare port (default 55433), createdb tafs_mcp
//   2. DATABASE_URL=<local> npx prisma db push --skip-generate
//   3. start the backend against it on PORT=3931 (no .env in the checkout)
//   4. psql ... -f scripts/verify-mcp/seed.sql   (synthetic users and students)
//   5. node scripts/verify-mcp/e2e.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const BASE = process.env.MCP_E2E_BASE ?? 'http://localhost:3931/api/v1';
const PG_PORT = process.env.MCP_E2E_PG_PORT ?? '55433';
const PG_DB = process.env.MCP_E2E_PG_DB ?? 'tafs_mcp';
if (!/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE)) {
  console.error('Refusing: MCP_E2E_BASE must be a local server.');
  process.exit(2);
}
const PASS = 'local-only-pass-1';
let failures = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
};
const sql = (q) => execFileSync('psql', ['-h', 'localhost', '-p', PG_PORT, '-U', 'postgres', PG_DB, '-tAc', q]).toString().trim();

async function login(username) {
  const r = await fetch(`${BASE}/auth/staff/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASS }),
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('tafs_access='));
  if (!cookie) throw new Error(`login failed for ${username}: ${r.status} ${await r.text()}`);
  return cookie.split(';')[0].slice('tafs_access='.length);
}
async function issue(jwt, name, extra = {}) {
  const r = await fetch(`${BASE}/mcp/tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ name, ...extra }),
  });
  return { status: r.status, body: await r.json() };
}
async function connect(token) {
  const client = new Client({ name: 'tafsd-531-e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}
const text = (res) => res.content?.[0]?.text ?? '';
const json = (res) => JSON.parse(text(res));
const rawPost = (token, body) => fetch(`${BASE}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body ?? { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});

// Synthetic local accounts: give them a known throwaway password.
const bcrypt = require('bcrypt');
sql(`update users set password_hash = '${bcrypt.hashSync(PASS, 4)}' where id like '00000000-0000-4000-8000-00000000000%'`);

const northJwt = await login('north.registrar');
const southJwt = await login('south.accounts');
const noAssistantJwt = await login('no.assistant');

// ── Token issue ─────────────────────────────────────────────────────────────
const north = await issue(northJwt, 'e2e north');
const south = await issue(southJwt, 'e2e south');
check('north issues a token', north.status === 201 && north.body.data.token.startsWith('tafs_pat_'));
check('south issues a token', south.status === 201);
const denied = await issue(noAssistantJwt, 'e2e none');
check('a user without the AI Assistant tile cannot issue a token', denied.status === 403, `status ${denied.status}`);
const tooLong = await issue(northJwt, 'too long', { expires_in_days: 365 });
check('expiry over 90 days refused', tooLong.status === 400, `status ${tooLong.status}`);
const stored = sql(`select count(*) from mcp_access_tokens where token_hash = encode(sha256('${north.body.data.token}'::bytea),'hex')`);
const clear = sql(`select count(*) from mcp_access_tokens where token_hash = '${north.body.data.token}' or token_prefix = '${north.body.data.token}'`);
check('only the SHA-256 is stored', stored === '1' && clear === '0');

// ── tools/list differs ──────────────────────────────────────────────────────
const nc = await connect(north.body.data.token);
const sc = await connect(south.body.data.token);
const nTools = (await nc.listTools()).tools.map((t) => t.name).sort();
const sTools = (await sc.listTools()).tools.map((t) => t.name).sort();
console.log('      north tools:', nTools.join(', '));
console.log('      south tools:', sTools.join(', '));
check('north (Student Directory) sees the student tools only',
  JSON.stringify(nTools) === JSON.stringify(['get_student', 'search_students', 'whoami']));
check('south (Vouchers, Single Voucher, Reports) sees finance tools and not get_student',
  sTools.includes('list_vouchers') && sTools.includes('get_student_arrears') && sTools.includes('list_defaulters') && !sTools.includes('get_student'));

// ── Same query, different data (scope) ──────────────────────────────────────
const nHits = json(await nc.callTool({ name: 'search_students', arguments: { q: 'Ali' } })).map((s) => s.cc).sort();
const sHits = json(await sc.callTool({ name: 'search_students', arguments: { q: 'Ali' } })).map((s) => s.cc).sort();
console.log('      search "Ali": north →', nHits.join(','), ' south →', sHits.join(','));
check('search_students "Ali" is scoped per user', JSON.stringify(nHits) === '[9001,9002]' && JSON.stringify(sHits) === '[9003]');

const own = await nc.callTool({ name: 'get_student', arguments: { cc: 9001 } });
check('north reads a campus-1 student', !own.isError && json(own).cc === 9001);
const other = await nc.callTool({ name: 'get_student', arguments: { cc: 9003 } });
check('north gets "not found" for a campus-2 student', other.isError === true, text(other));

// ── Re-check on call: not listed means not callable ─────────────────────────
let unlisted = '';
try { await nc.callTool({ name: 'list_vouchers', arguments: {} }); } catch (e) { unlisted = e.message; }
check('north cannot call list_vouchers (not listed)', /Unknown tool: list_vouchers/.test(unlisted), unlisted);

// ── Finance reads ───────────────────────────────────────────────────────────
const arrears = await sc.callTool({ name: 'get_student_arrears', arguments: { cc: 9003, fee_date: '2026-11-18' } });
check('south computes arrears for a campus-2 student (computeArrears)', !arrears.isError, text(arrears).slice(0, 120));
const arrearsOther = await sc.callTool({ name: 'get_student_arrears', arguments: { cc: 9001 } });
check('south is refused arrears for a campus-1 student', arrearsOther.isError === true, text(arrearsOther));
const defaulters = await sc.callTool({ name: 'list_defaulters', arguments: { limit: 5 } });
check('south lists defaulters', !defaulters.isError, text(defaulters).slice(0, 120));
const badArgs = await sc.callTool({ name: 'list_vouchers', arguments: { limit: 5, role: 'SUPER_ADMIN' } });
check('unknown arguments rejected like the HTTP route', badArgs.isError === true, text(badArgs));
const who = json(await sc.callTool({ name: 'whoami', arguments: {} }));
check('whoami reports scope and tools', who.username === 'south.accounts' && who.scope.campuses[0] === 2);

// ── Live access: removing a tile hides the tool on the next request ─────────
sql(`delete from user_tile_grants where user_id='00000000-0000-4000-8000-000000000003' and tile_id='finance.financial_reports'`);
// Live session reads sit behind a short cache that access writes invalidate; a raw SQL edit waits it out.
await new Promise((r) => setTimeout(r, 31_000));
const afterRevoke = (await (await connect(south.body.data.token)).listTools()).tools.map((t) => t.name);
check('a tile taken away drops its tool on the next request', !afterRevoke.includes('list_defaulters'), afterRevoke.join(','));

// ── Revoked / expired / wrong credential ────────────────────────────────────
const rev = await fetch(`${BASE}/mcp/tokens/${north.body.data.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${northJwt}` } });
check('north revokes its token', rev.status === 200);
const afterRev = await rawPost(north.body.data.token);
check('revoked token refused', afterRev.status === 401, `status ${afterRev.status}`);
let clientErr = '';
try { await nc.listTools(); } catch (e) { clientErr = e.message; }
check('the connected client is refused after revoke', clientErr !== '', clientErr.slice(0, 80));

const exp = await issue(southJwt, 'e2e soon expired', { expires_in_days: 1 });
sql(`update mcp_access_tokens set expires_at = now() - interval '1 minute' where id='${exp.body.data.id}'`);
const afterExp = await rawPost(exp.body.data.token);
check('expired token refused', afterExp.status === 401, `status ${afterExp.status}`);
check('browser JWT refused at /mcp', (await rawPost(southJwt)).status === 401);
check('no credential refused at /mcp', (await rawPost(null)).status === 401);
check('GET /mcp is 405', (await fetch(`${BASE}/mcp`)).status === 405);

// ── Tile removed entirely: token stops working ──────────────────────────────
const n2 = await issue(northJwt, 'e2e north 2');
sql(`delete from user_tile_grants where user_id='00000000-0000-4000-8000-000000000002' and tile_id='system.ai_assistant'`);
await new Promise((r) => setTimeout(r, 31_000));
check('losing the AI Assistant tile stops existing tokens', (await rawPost(n2.body.data.token)).status === 403);

// ── Audit ───────────────────────────────────────────────────────────────────
console.log(sql(`select action, entity_id, changed_by, left(note, 70), left(new_value, 50) from audit_logs where entity_type in ('MCP_TOOL','MCP_TOKEN') order by id`));
const leaked = sql(`select count(*) from audit_logs where note like '%tafs_pat_%' or new_value like '%tafs_pat_%' or old_value like '%tafs_pat_%'`);
check('no token in the audit log', leaked === '0');
check('denied call audited', sql(`select count(*) from audit_logs where entity_type='MCP_TOOL' and action='DENIED'`) !== '0');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
