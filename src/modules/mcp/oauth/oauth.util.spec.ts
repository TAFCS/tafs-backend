import { createHash } from 'crypto';
import {
  DEFAULT_REDIRECT_HOSTS,
  OAUTH_REFRESH_PREFIX,
  grantedScope,
  hasShape,
  isAllowedRedirectUri,
  isValidChallenge,
  newClientId,
  newToken,
  pkceChallenge,
  redirectHostsFrom,
  redirectUriMatches,
  sameResource,
  verifyPkce,
  withParams,
} from './oauth.util';

describe('MCP OAuth rules (TAFSD-531)', () => {
  describe('PKCE (S256 only)', () => {
    // RFC 7636 appendix B test vector.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

    it('computes the RFC 7636 test vector', () => {
      expect(pkceChallenge(verifier)).toBe(challenge);
    });

    it('accepts the right verifier and nothing else', () => {
      expect(verifyPkce(verifier, challenge)).toBe(true);
      expect(verifyPkce(verifier.slice(0, -1) + 'l', challenge)).toBe(false);
      // `plain` would send the verifier as the challenge: that never verifies.
      expect(verifyPkce(challenge, challenge)).toBe(false);
    });

    it('refuses verifiers outside RFC 7636 length and alphabet', () => {
      const short = 'a'.repeat(42);
      expect(verifyPkce(short, pkceChallenge(short))).toBe(false);
      const long = 'a'.repeat(129);
      expect(verifyPkce(long, pkceChallenge(long))).toBe(false);
      const spaced = `${'a'.repeat(42)} `;
      expect(
        verifyPkce(
          spaced,
          createHash('sha256').update(spaced).digest('base64url'),
        ),
      ).toBe(false);
      expect(verifyPkce(undefined, challenge)).toBe(false);
      expect(verifyPkce('a'.repeat(128), pkceChallenge('a'.repeat(128)))).toBe(
        true,
      );
    });

    it('only takes S256-shaped challenges', () => {
      expect(isValidChallenge(challenge)).toBe(true);
      expect(isValidChallenge(verifier + 'x')).toBe(false);
      expect(isValidChallenge('short')).toBe(false);
      expect(isValidChallenge(undefined)).toBe(false);
    });
  });

  describe('redirect URIs', () => {
    const hosts = DEFAULT_REDIRECT_HOSTS;

    it.each([
      'http://localhost:53121/callback',
      'http://127.0.0.1:8080/cb',
      'http://localhost/callback',
      'https://claude.ai/api/mcp/auth_callback',
      'https://app.claude.com/cb',
    ])('allows %s', (uri) =>
      expect(isAllowedRedirectUri(uri, hosts)).toBe(true),
    );

    it.each([
      'http://evil.example/cb',
      'https://evil.example/cb',
      'https://claude.ai.evil.example/cb',
      'https://notclaude.ai/cb',
      'https://claude.ai/cb#frag',
      'https://user:pw@claude.ai/cb',
      'javascript:alert(1)',
      'myapp://callback',
      'not a url',
      42,
    ])('refuses %s', (uri) =>
      expect(isAllowedRedirectUri(uri, hosts)).toBe(false),
    );

    it('reads the host allowlist from the environment, defaulting to Claude', () => {
      expect(redirectHostsFrom(undefined)).toEqual(['claude.ai', 'claude.com']);
      expect(redirectHostsFrom(' Example.com , ,cursor.sh')).toEqual([
        'example.com',
        'cursor.sh',
      ]);
      expect(
        isAllowedRedirectUri(
          'https://claude.ai/cb',
          redirectHostsFrom('example.com'),
        ),
      ).toBe(false);
    });

    it('matches exactly, except a loopback port (RFC 8252)', () => {
      const registered = [
        'http://localhost:4000/callback',
        'https://claude.ai/api/mcp/auth_callback',
      ];
      expect(
        redirectUriMatches(
          'https://claude.ai/api/mcp/auth_callback',
          registered,
        ),
      ).toBe(true);
      expect(
        redirectUriMatches('http://localhost:59999/callback', registered),
      ).toBe(true);
      expect(
        redirectUriMatches('http://localhost:59999/other', registered),
      ).toBe(false);
      expect(
        redirectUriMatches('http://127.0.0.1:4000/callback', registered),
      ).toBe(false);
      expect(
        redirectUriMatches(
          'https://claude.ai/api/mcp/auth_callback/x',
          registered,
        ),
      ).toBe(false);
      expect(
        redirectUriMatches(
          'https://claude.ai:8443/api/mcp/auth_callback',
          registered,
        ),
      ).toBe(false);
    });

    it('adds the code to the redirect URI without losing its own query', () => {
      expect(
        withParams('http://localhost:1/cb?x=1', {
          code: 'c',
          state: 's&t',
          missing: undefined,
        }),
      ).toBe('http://localhost:1/cb?x=1&code=c&state=s%26t');
    });
  });

  it('issues only the mcp scope', () => {
    expect(grantedScope(undefined)).toBe('mcp');
    expect(grantedScope('')).toBe('mcp');
    expect(grantedScope('mcp')).toBe('mcp');
    expect(grantedScope('mcp mcp')).toBe('mcp');
    expect(grantedScope('mcp admin')).toBeNull();
    expect(grantedScope(['mcp'])).toBeNull();
  });

  it('compares resources ignoring a trailing slash and host case', () => {
    expect(
      sameResource(
        'https://API.example.com/api/v1/mcp/',
        'https://api.example.com/api/v1/mcp',
      ),
    ).toBe(true);
    expect(
      sameResource(
        'https://api.example.com/api/v1/other',
        'https://api.example.com/api/v1/mcp',
      ),
    ).toBe(false);
    expect(
      sameResource(
        'http://api.example.com/api/v1/mcp',
        'https://api.example.com/api/v1/mcp',
      ),
    ).toBe(false);
    expect(sameResource('nope', 'nope')).toBe(false);
  });

  it('mints distinct random secrets of a fixed shape', () => {
    const a = newToken(OAUTH_REFRESH_PREFIX);
    expect(hasShape(a, OAUTH_REFRESH_PREFIX)).toBe(true);
    expect(newToken(OAUTH_REFRESH_PREFIX)).not.toBe(a);
    expect(hasShape(a, 'tafs_oac_')).toBe(false);
    expect(newClientId()).toMatch(/^tafs_mcp_client_[0-9a-f]{32}$/);
  });
});
