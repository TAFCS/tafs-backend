# Admin MCP end-to-end check (TAFSD-531)

Local only. `e2e.mjs` writes tokens, tile grants and audit rows to the database
it is pointed at and refuses a non-local server. Never run it against the shared
remote database.

```bash
export LC_ALL=en_US.UTF-8
PG=/opt/homebrew/opt/postgresql@17/bin
$PG/initdb -D /tmp/tafs-mcp-pg -U postgres --auth=trust
$PG/pg_ctl -D /tmp/tafs-mcp-pg -o "-p 55433" -l /tmp/tafs-mcp-pg.log start
$PG/createdb -p 55433 -U postgres tafs_mcp
export DATABASE_URL=postgresql://postgres@localhost:55433/tafs_mcp DIRECT_URL=$DATABASE_URL
npx prisma db push --skip-generate
# start the backend on it (from a checkout with no .env): PORT=3931 JWT_SECRET=... node dist/src/main.js
psql -p 55433 -U postgres tafs_mcp -f scripts/verify-mcp/seed.sql
node scripts/verify-mcp/e2e.mjs
```

It checks: two users with different tiles get different `tools/list` and
different rows for the same search; out-of-scope reads come back "not found";
an unlisted tool cannot be called; a tile taken away drops its tool on the next
request; revoked, expired, JWT and missing credentials are refused; losing the
AI Assistant tile stops existing tokens; every call is audited with no token in
the log. It waits twice for the 30-second live-session cache, so it takes about
a minute and a half.
