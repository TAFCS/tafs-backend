import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { MCP_OAUTH_ACCESS_PREFIX, hashMcpToken } from '../mcp-token.util';

/**
 * TAFSD-531: OAuth 2.1 for the admin MCP server, following the MCP
 * authorization spec. Pure rules only; the database work is OAuthService.
 */

export const OAUTH_SCOPE = 'mcp';
export const OAUTH_ACCESS_PREFIX = MCP_OAUTH_ACCESS_PREFIX;
export const OAUTH_REFRESH_PREFIX = 'tafs_ort_';
export const OAUTH_CODE_PREFIX = 'tafs_oac_';
export const OAUTH_CLIENT_PREFIX = 'tafs_mcp_client_';

export const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;
export const OAUTH_ACCESS_TTL_MS = 60 * 60 * 1000;
export const OAUTH_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A grant's hard end: refresh never carries it further (same cap as a personal token). */
export const OAUTH_GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** How long a person has to sign in and answer the consent screen. */
export const OAUTH_TICKET_TTL_S = 10 * 60;
export const OAUTH_TICKET_AUDIENCE = 'tafs-mcp-authorize';

export const OAUTH_MAX_REDIRECT_URIS = 5;
/** https redirect hosts allowed when MCP_OAUTH_REDIRECT_HOSTS is not set. */
export const DEFAULT_REDIRECT_HOSTS = ['claude.ai', 'claude.com'];

/** The MCP resource path on this server, below the public origin. */
export const MCP_RESOURCE_PATH = '/api/v1/mcp';
export const OAUTH_BASE_PATH = '/api/v1/mcp/oauth';

const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636: 43-128 characters from the unreserved set. */
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export const newToken = (prefix: string) =>
  prefix + randomBytes(32).toString('base64url');
export const newClientId = () =>
  OAUTH_CLIENT_PREFIX + randomBytes(16).toString('hex');
export { hashMcpToken as hashOAuthSecret };

export function hasShape(value: unknown, prefix: string): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(prefix) &&
    B64URL_43.test(value.slice(prefix.length))
  );
}

/** S256 challenge for a verifier: BASE64URL(SHA256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** A challenge we accept: S256 output, so exactly 43 base64url characters. */
export function isValidChallenge(challenge: unknown): challenge is string {
  return typeof challenge === 'string' && B64URL_43.test(challenge);
}

/** Whether `verifier` proves possession of the S256 `challenge`. */
export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !PKCE_VERIFIER.test(verifier))
    return false;
  const a = Buffer.from(pkceChallenge(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Hosts an https redirect may point at, from MCP_OAUTH_REDIRECT_HOSTS (comma-separated). */
export function redirectHostsFrom(env: string | undefined): string[] {
  const hosts = (env ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length ? hosts : DEFAULT_REDIRECT_HOSTS;
}

/**
 * Whether a client may register this redirect URI. Loopback http on any port
 * (native and CLI clients: Claude Code, Cursor) or https on an allowed host
 * or its subdomain. No fragments, no credentials in the URL.
 */
export function isAllowedRedirectUri(
  uri: unknown,
  allowedHosts: string[],
): uri is string {
  if (typeof uri !== 'string' || uri.length > 500) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'http:')
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (u.protocol !== 'https:') return false;
  return allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Exact match against the registered list, except that a loopback URI may
 * differ in port (RFC 8252 §7.3: native clients pick a free port each run).
 */
export function redirectUriMatches(
  requested: string,
  registered: string[],
): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (r.protocol !== 'http:') return false;
  return registered.some((reg) => {
    try {
      const g = new URL(reg);
      return (
        g.protocol === 'http:' &&
        g.hostname === r.hostname &&
        g.pathname === r.pathname &&
        g.search === r.search &&
        ['localhost', '127.0.0.1', '[::1]'].includes(g.hostname)
      );
    } catch {
      return false;
    }
  });
}

/** The granted scope for a requested one: `mcp` (or nothing) is all we issue. */
export function grantedScope(requested: unknown): string | null {
  if (requested === undefined || requested === null || requested === '')
    return OAUTH_SCOPE;
  if (typeof requested !== 'string') return null;
  const parts = requested.split(/\s+/).filter(Boolean);
  return parts.every((p) => p === OAUTH_SCOPE) ? OAUTH_SCOPE : null;
}

/** Same resource, ignoring a trailing slash and the case of scheme and host. */
export function sameResource(a: string, b: string): boolean {
  const norm = (v: string) => {
    try {
      const u = new URL(v);
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return null;
    }
  };
  const na = norm(a);
  return na !== null && na === norm(b);
}

/** Append query parameters to a redirect URI, keeping any it already has. */
export function withParams(
  uri: string,
  params: Record<string, string | undefined>,
): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

export const earliest = (...dates: Date[]) =>
  new Date(Math.min(...dates.map((d) => d.getTime())));
