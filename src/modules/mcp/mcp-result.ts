/** Largest tool result handed back, in characters of JSON. */
export const MCP_RESULT_MAX_CHARS = 100_000;

/** JSON text of a tool result; bigint becomes a string rather than throwing. */
export function serializeResult(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ) ?? 'null'
  );
}

/** Cut an over-long result, saying so, so the assistant narrows the query instead. */
export function capResult(
  text: string,
  max = MCP_RESULT_MAX_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text:
      text.slice(0, max) +
      `\n\n[Result truncated at ${max} of ${text.length} characters. Narrow the query with filters, page or limit.]`,
    truncated: true,
  };
}

const MAX_SCALAR = 40;
const MAX_SUMMARY = 500;

/**
 * A short, log-safe picture of a tool call's arguments for the audit row:
 * numbers and booleans as given, text cut to 40 characters, arrays of more
 * than five items reduced to a count, nested objects elided. Tool arguments
 * are search terms and ids, never credentials, but nothing long is kept.
 */
export function summarizeArgs(
  args: Record<string, unknown> | undefined,
): string {
  if (!args || typeof args !== 'object') return '{}';
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args).slice(0, 20)) {
    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
      out[key] = value;
    else if (typeof value === 'string')
      out[key] =
        value.length > MAX_SCALAR ? `${value.slice(0, MAX_SCALAR)}…` : value;
    else if (Array.isArray(value))
      out[key] =
        value.length > 5
          ? `[${value.length} items]`
          : value.map((v) => (typeof v === 'object' ? '…' : v));
    else out[key] = '…';
  }
  const text = JSON.stringify(out);
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text;
}
