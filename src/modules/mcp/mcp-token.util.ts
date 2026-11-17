import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * TAFSD-531: personal access tokens for the admin MCP server.
 *
 * A token is `tafs_pat_` + 43 base64url characters (32 random bytes). Only its
 * SHA-256 is stored: with 256 bits of entropy a slow password hash buys
 * nothing, and a fast one keeps the per-request lookup to one indexed read.
 */
export const MCP_TOKEN_PREFIX = 'tafs_pat_';
/** Characters of the token kept in clear, so a person can tell tokens apart. */
export const MCP_TOKEN_DISPLAY_CHARS = MCP_TOKEN_PREFIX.length + 6;
export const MCP_TOKEN_DEFAULT_DAYS = 30;
export const MCP_TOKEN_MAX_DAYS = 90;
/** Live (unrevoked, unexpired) tokens one person may hold at once. */
export const MCP_TOKEN_MAX_LIVE = 10;
/** last_used_at is refreshed at most this often per token, to keep reads cheap. */
export const MCP_TOKEN_TOUCH_INTERVAL_MS = 60_000;

const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/;

export function generateMcpToken(): string {
  return MCP_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Shape check only; whether the token exists is the database's answer. */
export function looksLikeMcpToken(
  value: string | null | undefined,
): value is string {
  if (!value || !value.startsWith(MCP_TOKEN_PREFIX)) return false;
  return TOKEN_BODY.test(value.slice(MCP_TOKEN_PREFIX.length));
}

export function displayPrefix(token: string): string {
  return token.slice(0, MCP_TOKEN_DISPLAY_CHARS);
}

/** `Authorization: Bearer <token>` → token, or null. Case-insensitive scheme. */
export function bearerFrom(
  header: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(raw);
  return match ? match[1] : null;
}

/** Constant-time comparison of two hex digests of equal length. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Expiry for a token issued now, from the requested lifetime in days. */
export function expiryFor(now: Date, days: number | undefined): Date {
  const d = days ?? MCP_TOKEN_DEFAULT_DAYS;
  if (!Number.isInteger(d) || d < 1 || d > MCP_TOKEN_MAX_DAYS) {
    throw new RangeError(
      `expires_in_days must be a whole number from 1 to ${MCP_TOKEN_MAX_DAYS}`,
    );
  }
  return new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
}

export type McpTokenRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
};

export type McpTokenRejection = 'malformed' | 'unknown' | 'revoked' | 'expired';

/**
 * Whether a stored row lets `presented` in at `now`. Pure, so the rules can be
 * tested without a database: the hash must match, the token must not be
 * revoked, and it must not have reached its expiry.
 */
export function checkMcpToken(
  presented: string | null | undefined,
  row: McpTokenRow | null,
  now: Date,
): { ok: true } | { ok: false; reason: McpTokenRejection } {
  if (!looksLikeMcpToken(presented)) return { ok: false, reason: 'malformed' };
  if (!row || !sameHash(hashMcpToken(presented), row.token_hash))
    return { ok: false, reason: 'unknown' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.expires_at.getTime() <= now.getTime())
    return { ok: false, reason: 'expired' };
  return { ok: true };
}
