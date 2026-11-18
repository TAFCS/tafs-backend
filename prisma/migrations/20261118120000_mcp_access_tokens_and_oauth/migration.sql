-- TAFSD-531: the admin MCP server (/api/v1/mcp): access tokens and OAuth 2.1.
--
-- mcp_access_tokens: every token the MCP endpoint accepts. A personal access
--   token (grant_id NULL) is issued by a person on the AI Assistant page; an
--   OAuth access token (grant_id set) is issued by /mcp/oauth/token and lives
--   an hour. Only the SHA-256 of a token is stored. A token acts as its owner:
--   role, tiles, actions and scope are resolved live on every request.
-- mcp_oauth_clients: clients registered through RFC 7591 dynamic
--   registration. Public clients only (no secret); PKCE S256 is required.
-- mcp_oauth_grants: one approval a person gave one client, revocable from the
--   AI Assistant page. Revoking it kills its access and refresh tokens.
-- mcp_oauth_codes: single-use authorization codes, minutes long, bound to the
--   client, redirect URI and PKCE challenge. Stored hashed.
-- mcp_oauth_refresh_tokens: rotated on every use; replaying a used one
--   revokes the grant. Stored hashed.
--
-- New tables only; nothing existing changes. Deploy this migration BEFORE the
-- code that reads it (CLAUDE.md rule 11).

-- CreateTable
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
    "grant_id" TEXT,

    CONSTRAINT "mcp_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_oauth_clients" (
    "id" VARCHAR(64) NOT NULL,
    "client_name" VARCHAR(200) NOT NULL,
    "client_uri" VARCHAR(500),
    "redirect_uris" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_oauth_grants" (
    "id" TEXT NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "user_id" TEXT NOT NULL,
    "scope" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" VARCHAR(50),

    CONSTRAINT "mcp_oauth_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_oauth_codes" (
    "id" TEXT NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "user_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" VARCHAR(128) NOT NULL,
    "scope" VARCHAR(200) NOT NULL,
    "resource" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "grant_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_oauth_refresh_tokens" (
    "id" TEXT NOT NULL,
    "grant_id" TEXT NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_access_tokens_token_hash_key" ON "mcp_access_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "idx_mcp_access_tokens_user" ON "mcp_access_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "idx_mcp_access_tokens_grant" ON "mcp_access_tokens"("grant_id");

-- CreateIndex
CREATE INDEX "idx_mcp_oauth_grants_user" ON "mcp_oauth_grants"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_oauth_codes_code_hash_key" ON "mcp_oauth_codes"("code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_oauth_refresh_tokens_token_hash_key" ON "mcp_oauth_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "idx_mcp_oauth_refresh_tokens_grant" ON "mcp_oauth_refresh_tokens"("grant_id");

-- AddForeignKey
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "mcp_oauth_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_codes" ADD CONSTRAINT "mcp_oauth_codes_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "mcp_oauth_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_refresh_tokens" ADD CONSTRAINT "mcp_oauth_refresh_tokens_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "mcp_oauth_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

