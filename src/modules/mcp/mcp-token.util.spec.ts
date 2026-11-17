import {
  MCP_TOKEN_MAX_DAYS,
  MCP_TOKEN_PREFIX,
  bearerFrom,
  checkMcpToken,
  displayPrefix,
  expiryFor,
  generateMcpToken,
  hashMcpToken,
  looksLikeMcpToken,
} from './mcp-token.util';

describe('MCP personal access tokens (TAFSD-531)', () => {
  const now = new Date('2026-11-18T10:00:00Z');
  const token = generateMcpToken();
  const row = (
    over: Partial<Parameters<typeof checkMcpToken>[1] & object> = {},
  ) => ({
    id: 't1',
    user_id: 'u1',
    token_hash: hashMcpToken(token),
    expires_at: new Date('2026-12-18T10:00:00Z'),
    revoked_at: null,
    ...over,
  });

  it('issues a prefixed 256-bit token that is never stored in clear', () => {
    expect(token.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
    expect(looksLikeMcpToken(token)).toBe(true);
    expect(generateMcpToken()).not.toBe(token);
    expect(hashMcpToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMcpToken(token)).not.toContain(
      token.slice(MCP_TOKEN_PREFIX.length),
    );
    // The display prefix gives away 6 of the 43 random characters at most.
    expect(displayPrefix(token)).toBe(
      token.slice(0, MCP_TOKEN_PREFIX.length + 6),
    );
  });

  it('accepts a live token', () => {
    expect(checkMcpToken(token, row(), now)).toEqual({ ok: true });
  });

  it('refuses a revoked token', () => {
    expect(
      checkMcpToken(
        token,
        row({ revoked_at: new Date('2026-11-17T00:00:00Z') }),
        now,
      ),
    ).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('refuses a token at and after its expiry', () => {
    expect(checkMcpToken(token, row({ expires_at: now }), now)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(
      checkMcpToken(
        token,
        row({ expires_at: new Date('2026-11-01T00:00:00Z') }),
        now,
      ),
    ).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses an unknown token and a row whose hash does not match', () => {
    expect(checkMcpToken(token, null, now)).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(checkMcpToken(generateMcpToken(), row(), now)).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('refuses anything not shaped like a token, including a browser JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln';
    for (const bad of [
      undefined,
      null,
      '',
      jwt,
      MCP_TOKEN_PREFIX,
      `${MCP_TOKEN_PREFIX}short`,
      `${token}x`,
      token.toUpperCase(),
    ]) {
      expect(looksLikeMcpToken(bad)).toBe(false);
      expect(checkMcpToken(bad, row(), now)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('reads the bearer header', () => {
    expect(bearerFrom(`Bearer ${token}`)).toBe(token);
    expect(bearerFrom(`bearer   ${token} `)).toBe(token);
    expect(bearerFrom([`Bearer ${token}`])).toBe(token);
    expect(bearerFrom(undefined)).toBeNull();
    expect(bearerFrom(`Basic ${token}`)).toBeNull();
    expect(bearerFrom('Bearer a b')).toBeNull();
  });

  it('expires in 30 days by default and never later than the cap', () => {
    expect(expiryFor(now, undefined).toISOString()).toBe(
      '2026-12-18T10:00:00.000Z',
    );
    expect(expiryFor(now, 1).toISOString()).toBe('2026-11-19T10:00:00.000Z');
    expect(() => expiryFor(now, MCP_TOKEN_MAX_DAYS + 1)).toThrow(RangeError);
    expect(() => expiryFor(now, 0)).toThrow(RangeError);
    expect(() => expiryFor(now, 1.5)).toThrow(RangeError);
  });
});
