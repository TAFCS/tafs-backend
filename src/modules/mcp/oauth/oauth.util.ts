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
/**
 * The https redirect URIs a client may register, matched exactly, when
 * MCP_OAUTH_REDIRECT_URIS is not set:
 * - the callback claude.ai custom connectors use (web, desktop and mobile
 *   share it), on both Claude domains;
 * - ChatGPT's stable connector callback (TAFSD-540). ChatGPT uses it for
 *   servers that send the RFC 9207 `iss` parameter, which this one does;
 *   otherwise it falls back to a per-connector /connector/oauth/{id} URL,
 *   which would have to be added to MCP_OAUTH_REDIRECT_URIS by hand.
 */
export const DEFAULT_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
];

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

/** Exact https redirect URIs from MCP_OAUTH_REDIRECT_URIS (comma-separated), or the default. */
export function redirectAllowlistFrom(env: string | undefined): string[] {
  const uris = (env ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  return uris.length ? uris : DEFAULT_REDIRECT_URIS;
}

/**
 * Whether a client may register this redirect URI: loopback http on any port
 * and path (native and CLI clients: Claude Code, Cursor; the code only ever
 * reaches the person's own machine), or an https URI on the allowlist,
 * matched exactly: no other host, subdomain or path. No fragments, no
 * credentials in the URL.
 */
export function isAllowedRedirectUri(
  uri: unknown,
  allowlist: string[],
): uri is string {
  if (typeof uri !== 'string' || uri.length > 500) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'http:') return isLoopbackHost(u.hostname);
  if (u.protocol !== 'https:') return false;
  return allowlist.includes(uri);
}

const isLoopbackHost = (host: string) =>
  ['localhost', '127.0.0.1', '[::1]'].includes(host.toLowerCase());

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
        isLoopbackHost(g.hostname)
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

/**
 * A fixed-window counter, per key and in total, for the public registration
 * endpoint. In memory and per instance: it caps abuse, it is not an account.
 */
export class WindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private total = { count: 0, resetAt: 0 };

  constructor(
    private readonly perKey: number,
    private readonly overall: number,
    private readonly windowMs: number,
  ) {}

  /** Records an attempt; false when either limit is already reached. */
  take(key: string, now = Date.now()): boolean {
    if (now >= this.total.resetAt)
      this.total = { count: 0, resetAt: now + this.windowMs };
    let entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    if (entry.count >= this.perKey || this.total.count >= this.overall)
      return false;
    entry.count++;
    this.total.count++;
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k);
    }
    return true;
  }
}

/** Origin of a URL, or null when it is not one. */
export function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
