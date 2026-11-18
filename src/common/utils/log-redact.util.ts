/**
 * TAFSD-531: URLs as they may be written to logs. The MCP OAuth flow carries
 * one-time values in query strings (authorize state and PKCE challenge, the
 * consent page's ticket, codes on the way back), so for those paths, and for
 * any URL carrying a ticket or code parameter, the query is dropped.
 */
const SENSITIVE_PATH = /\/mcp\/(oauth|authorize)\b/;
const SENSITIVE_PARAM = /[?&](ticket|code|code_verifier|refresh_token|state)=/i;

export function redactUrl(url: string | undefined | null): string {
  if (!url) return '';
  const q = url.indexOf('?');
  if (q === -1) return url;
  if (
    SENSITIVE_PATH.test(url.slice(0, q)) ||
    SENSITIVE_PARAM.test(url.slice(q))
  ) {
    return `${url.slice(0, q)}?[redacted]`;
  }
  return url;
}
