# Admin MCP server (TAFSD-531)

Staff can connect an AI assistant (Claude Code, claude.ai, Claude Desktop,
Cursor, any MCP client) to TAFS. The assistant acts as that person: it sees
only the tools their tiles allow and only the records their scope allows.

## Who can use it

A SUPER_ADMIN grants the person the **AI Assistant (MCP)** tile
(`system.ai_assistant`, capability `system.ai_assistant.use`) in People &
Access. Default-deny, like every web tile. Taking it away stops every token
and connection the person has, on the next request.

## Connecting with sign-in (OAuth 2.1, recommended)

```bash
claude mcp add --transport http tafs https://<backend-host>/api/v1/mcp
```

In claude.ai: Settings → Connectors → Add custom connector, URL
`https://<backend-host>/api/v1/mcp`. The client finds everything else itself:

1. `POST /api/v1/mcp` without a token → **401** with
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/api/v1/mcp"`.
2. Discovery, served at the **origin root** (outside `/api/v1`):
   `/.well-known/oauth-protected-resource` (also with `/api/v1/mcp` appended)
   and `/.well-known/oauth-authorization-server`. The issuer is the backend
   origin.
3. Dynamic client registration, `POST /api/v1/mcp/oauth/register` (RFC 7591).
   Public clients only (no secret). Redirect URIs must be loopback
   `http://localhost` / `127.0.0.1` (any port), or an `https` URI listed
   **exactly** in `MCP_OAUTH_REDIRECT_URIS` (default
   `https://claude.ai/api/mcp/auth_callback` and
   `https://claude.com/api/mcp/auth_callback`; no other path, subdomain or
   port). Rate-limited to 20 registrations per address and 500 overall per
   hour, per instance.
4. `GET /api/v1/mcp/oauth/authorize` checks the client, the exact redirect URI
   (a loopback port may differ, RFC 8252) and a PKCE **S256** challenge
   (`plain` is refused), then redirects to the webapp's
   `WEBAPP_URL/mcp/authorize?ticket=…`. The ticket is a signed, 10-minute JWT
   carrying the request and the issuer, with a `jti`. It belongs to the first
   signed-in person who opens it (`mcp_oauth_consents`) and takes one answer.
5. The webapp page signs the person in if needed (normal TAFS login, which
   returns to the page with its ticket) and shows the consent screen: the app's
   name, where it sends them back, that it acts as them, and the exact tools
   they would get. The name is marked unverified (the app chose it) next to
   the address it returns to. Approve or deny. Someone without the tile, or
   impersonating, can only go back to the app.
   The consent API (`GET/POST /api/v1/mcp/oauth/consent`) accepts only the
   webapp's own Origin (`WEBAPP_URL`): a POST must carry it, a GET is refused
   with another Origin or `Sec-Fetch-Site: cross-site`. The session cookie is
   `SameSite=None` in production, so without this any site could approve on a
   signed-in person's behalf. The page itself cannot be framed.
6. `POST /api/v1/mcp/oauth/token`:
   - `authorization_code`: single-use code, 5 minutes, bound to the client,
     redirect URI and challenge; the verifier must match. Claiming the code,
     creating the grant and issuing tokens is one transaction; replaying a
     used code, even simultaneously, revokes the grant it produced.
   - `refresh_token`: rotates on every use. Replaying a used refresh token
     revokes the whole grant (theft detection).
   - Access token 1 hour, refresh token 30 days, grant 90 days at most.
   - The person is re-checked live (active, AI Assistant tile) on every
     exchange and refresh.
7. `POST /api/v1/mcp/oauth/revoke` (RFC 7009) revokes a grant from the client.

Each person sees and disconnects their connections under System → AI
Assistant (MCP) → Connected apps (`GET/DELETE /api/v1/mcp/grants`).

## Connecting with a personal token

For clients without OAuth: `POST /api/v1/mcp/tokens {"name": "…",
"expires_in_days": 30}` while logged in (or the same page in the webapp). The
token is shown once; only its SHA-256 is stored. 30 days by default, 90 at
most, 10 live per person, never issued while impersonating.

```bash
claude mcp add --transport http tafs https://<backend-host>/api/v1/mcp --header "Authorization: Bearer tafs_pat_..."
```

## How access works

- `POST /api/v1/mcp`, Streamable HTTP, stateless JSON (no sessions, no SSE).
  Accepts personal tokens and OAuth access tokens, never the browser session.
- Both kinds are `mcp_access_tokens` rows (an OAuth one has `grant_id`). The
  token names its owner; `JwtStaffStrategy.validate` builds the same live
  principal a browser request gets (role, capabilities, tile actions, scope).
- Each tool mirrors one existing route (`mcp-tools.ts`, `route`). Who may use
  it is decided by running that route's own `PoliciesGuard` and
  `TileActionGuard` over its metadata (`mcp-access.ts`). `tools/list` shows only
  passing tools; `tools/call` checks again and reports a forbidden tool as
  unknown. The controller method itself runs, so its scope checks apply.
- Every secret (tokens, refresh tokens, codes) is stored hashed.

## Audit

| entity_type | actions |
|---|---|
| `MCP_TOOL` | `CALL`, `DENIED`, `ERROR`: caller, argument summary, credential (`token <id>` or `oauth grant <id>`), result size |
| `MCP_TOKEN` | `CREATE`, `REVOKE` (personal tokens) |
| `MCP_OAUTH` | `CLIENT_REGISTER`, `CONSENT_APPROVE`, `CONSENT_DENY`, `TOKEN_ISSUE`, `TOKEN_REFRESH`, `GRANT_REVOKE` (reason: `user_revoked`, `client_revoked`, `refresh_reuse`, `code_reuse`) |

No token or code is ever written to a log.

## Deploying

- Migration `prisma/migrations/20261118120000_mcp_access_tokens_and_oauth`
  first (new tables only), then the code.
- Env:
  - `WEBAPP_URL` (required for sign-in): the webapp origin the consent page is
    served from, e.g. `https://tafs-webapp.vercel.app`. Without it, sign-in
    answers `temporarily_unavailable`; personal tokens still work.
  - `MCP_PUBLIC_URL` (**required in production** for sign-in): the backend's
    public origin as clients reach it, e.g. `https://api.example.com`. It is
    the OAuth issuer. Without it in production, OAuth and its metadata answer
    503 and the 401 carries no `resource_metadata` (personal tokens still
    work); request headers are never trusted to name the issuer there.
    Outside production it falls back to `X-Forwarded-*` / `Host`.
  - `MCP_OAUTH_REDIRECT_URIS` (optional): exact https redirect URIs clients may
    register, comma-separated. Default the claude.ai and claude.com connector
    callbacks above. (Replaces `MCP_OAUTH_REDIRECT_HOSTS`, which never
    shipped.)
- The backend origin root must route `/.well-known/*` to the backend.
- CORS with credentials now allows only `tafs-webapp.vercel.app`, this
  project's own deployments (`tafs-webapp-<hash>-…` and
  `tafs-webapp-git-<branch>-tafstechsystems-1600s-projects.vercel.app`),
  `http://localhost:*` and `CORS_ORIGIN`, not any `*.vercel.app`.
- Logs: OAuth query strings (tickets, codes, state) are redacted from the
  request log, the slow-request log and morgan (URL and referrer).
- The webapp must be deployed with `/mcp/authorize` (after the backend).

## Adding a tool

Add an entry to `MCP_TOOLS` pointing at an existing controller method behind
`JwtStaffGuard`, `PoliciesGuard` and `TileActionGuard` (the registry spec fails
otherwise). Never give a tool its own permission check or query: reuse the
route so it cannot be wider than the page. A write tool must mirror a route
gated by its own action grant.

## Tests

- Unit: `npx jest src/modules/mcp`: token rules, PKCE (RFC 7636 vector),
  redirect URIs, scope/resource, tool filtering, call path.
- DB: `test/db/mcp-oauth.db-spec.ts`: the whole OAuth flow over HTTP on a real
  Postgres (discovery, registration, authorize, consent incl. no-tile and deny,
  PKCE, code replay, refresh rotation and replay, revocation, tile loss, scope,
  audit). Runs in CI (`DB tests`).
- Manual: `scripts/verify-mcp/` (personal tokens, local only).

## Not yet

- An admin view of everyone's tokens and connections.
- Write tools.
- Cleanup of registered clients that never completed a sign-in.
