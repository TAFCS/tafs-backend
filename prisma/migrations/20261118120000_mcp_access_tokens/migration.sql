-- TAFSD-531: personal access tokens for the admin MCP server (/api/v1/mcp).
--
-- One row per token a staff member issues for an AI assistant. Only the
-- SHA-256 of the token is stored (the token is 32 random bytes, shown once).
-- A token acts as its owner: role, tiles, actions and scope are resolved live
-- on every request, exactly as for a browser session, so revoking a tile or
-- deactivating the account takes effect immediately. Revoking the token sets
-- revoked_at; rows are kept for the audit trail.
--
-- Deploy this migration BEFORE the code that reads it (CLAUDE.md rule 11).

CREATE TABLE "mcp_access_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "token_prefix" VARCHAR(20) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_access_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mcp_access_tokens_token_hash_key" ON "mcp_access_tokens"("token_hash");

CREATE INDEX "idx_mcp_access_tokens_user" ON "mcp_access_tokens"("user_id", "revoked_at");

ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
