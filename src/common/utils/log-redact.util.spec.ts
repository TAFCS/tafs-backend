import { redactUrl } from './log-redact.util';

describe('redactUrl (TAFSD-531)', () => {
  it('drops the query of MCP OAuth URLs', () => {
    expect(
      redactUrl(
        '/api/v1/mcp/oauth/authorize?client_id=x&state=s&code_challenge=c',
      ),
    ).toBe('/api/v1/mcp/oauth/authorize?[redacted]');
    expect(redactUrl('/api/v1/mcp/oauth/consent?ticket=eyJ.abc.def')).toBe(
      '/api/v1/mcp/oauth/consent?[redacted]',
    );
    expect(
      redactUrl('https://webapp.example/mcp/authorize?ticket=eyJ.abc.def'),
    ).toBe('https://webapp.example/mcp/authorize?[redacted]');
  });

  it('drops the query of any URL carrying a ticket or code', () => {
    expect(
      redactUrl('http://localhost:5555/callback?code=tafs_oac_x&state=y'),
    ).toBe('http://localhost:5555/callback?[redacted]');
    expect(redactUrl('/anything?foo=1&ticket=abc')).toBe(
      '/anything?[redacted]',
    );
  });

  it('leaves every other URL alone', () => {
    expect(redactUrl('/api/v1/students?q=ali&page=2')).toBe(
      '/api/v1/students?q=ali&page=2',
    );
    expect(redactUrl('/api/v1/auth/staff/login')).toBe(
      '/api/v1/auth/staff/login',
    );
    expect(redactUrl('/api/v1/vouchers?status=PAID&encoded=x')).toBe(
      '/api/v1/vouchers?status=PAID&encoded=x',
    );
    expect(redactUrl(undefined)).toBe('');
  });
});
