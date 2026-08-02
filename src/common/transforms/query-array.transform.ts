/** Accepts a single value, comma-separated string, or array → number[]. */
export function toNumberArray({ value }: { value: unknown }): number[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const nums = raw
    .map((v) => Number(String(v).trim()))
    .filter((n) => Number.isInteger(n) && !Number.isNaN(n));
  return nums.length ? nums : undefined;
}

/** Accepts a single value, comma-separated string, or array → string[]. */
export function toStringArray({ value }: { value: unknown }): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const items = raw.map((v) => String(v).trim()).filter(Boolean);
  return items.length ? items : undefined;
}
