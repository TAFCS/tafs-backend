# Admin MCP server (TAFSD-531)

Staff can connect an AI assistant (Claude Code, Claude Desktop, Cursor, any MCP
client) to TAFS. The assistant acts as that person: it sees only the tools their
tiles allow and only the records their scope allows.

## Connecting

1. A SUPER_ADMIN grants the person the **AI Assistant (MCP)** tile
   (`system.ai_assistant`) in People & Access. Default-deny, like every web tile.
2. The person issues a token for themselves:
   `POST /api/v1/mcp/tokens {"name": "Claude Code on my laptop", "expires_in_days": 30}`
   (logged in). The response carries `token` once; only its SHA-256 is stored.
   `GET /api/v1/mcp/tokens` lists theirs, `DELETE /api/v1/mcp/tokens/:id` revokes one.
   Expiry: 30 days by default, 90 at most; 10 live tokens per person. A token
   cannot be issued while impersonating.
3. Add the server to the client:

```bash
claude mcp add --transport http tafs https://<backend-host>/api/v1/mcp --header "Authorization: Bearer tafs_pat_..."
```

## How access works

- `POST /api/v1/mcp`, Streamable HTTP, stateless JSON (no sessions, no SSE).
  Only personal access tokens are accepted here, never the browser session.
- The token names its owner; `JwtStaffStrategy.validate` then builds the same
  principal a browser request gets (live role, capabilities, tile actions,
  scope). An inactive account or a lost AI Assistant tile is refused on the
  next request.
- Each tool mirrors one existing route (`mcp-tools.ts`, `route`). Who may use it
  is decided by running that route's own `PoliciesGuard` and `TileActionGuard`
  over its `@CheckPolicies` / `@RequireAction` / `@RequireAnyAction` /
  `@RequireAnyTile` metadata (`mcp-access.ts`). `tools/list` shows only the
  tools that pass; `tools/call` checks again and reports a forbidden tool as
  unknown. The tool then calls the controller method itself, so its scope
  checks (`assertStudentVisible`, `ScopeService`) run unchanged.
- Arguments pass through the HTTP app's ValidationPipe options (whitelist,
  forbid unknown properties, transform).
- Every `tools/call` writes an `audit_logs` row: `entity_type = MCP_TOOL`,
  `action` CALL / DENIED / ERROR, the caller, a short argument summary, the
  token id and the result size. Token issue and revoke write `MCP_TOKEN` rows.

## Adding a tool

Add an entry to `MCP_TOOLS` pointing at an existing controller method that sits
behind `JwtStaffGuard`, `PoliciesGuard` and `TileActionGuard` (the registry spec
fails otherwise). Never give a tool its own permission check or its own query:
reuse the route so the tool cannot be wider than the page. A write tool must
mirror a route gated by its own action grant.

## Not yet

- OAuth 2.1 (needed for Claude.ai custom connectors): protected-resource
  metadata, an authorization server (TAFS login + consent page, `/token` with
  PKCE, dynamic client registration), refresh tokens. The token table can back
  the access tokens it issues.
- Admin view of everyone's tokens and admin revoke.
- Write tools.
