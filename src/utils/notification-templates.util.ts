import { PrismaService } from '../../prisma/prisma.service';

/** Replace `{variable}` placeholders with values from the vars map. */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

function getCached(key: string): string | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCache(key: string, value: string | null) {
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

/** Clear the in-memory template cache (useful in tests). */
export function clearTemplateCache() {
  cache.clear();
}

/**
 * Check whether a notification type is disabled via `app_config`.
 * Uses the same cache with `_disabled` suffix keys.
 * The `templateKey` should be the title key (e.g. `notif_fee_issued_title`);
 * the disabled key is derived by replacing `_title` with `_disabled`.
 */
export async function isTemplateDisabled(
  prisma: PrismaService,
  templateKey: string,
): Promise<boolean> {
  const disabledKey = templateKey.replace(/_title$/, '_disabled');
  const cached = getCached(disabledKey);
  if (cached !== undefined) {
    return cached === 'true';
  }

  try {
    const row = await prisma.app_config.findUnique({ where: { key: disabledKey } });
    setCache(disabledKey, row?.value ?? null);
    return row?.value === 'true';
  } catch {
    return false;
  }
}

/**
 * Load a notification template from `app_config`, falling back to the
 * hardcoded default if no row exists, then interpolate variables.
 */
export async function resolveTemplate(
  prisma: PrismaService,
  key: string,
  fallback: string,
  vars: Record<string, string> = {},
): Promise<string> {
  const cached = getCached(key);
  if (cached !== undefined) {
    return interpolate(cached ?? fallback, vars);
  }

  try {
    const row = await prisma.app_config.findUnique({ where: { key } });
    // A template saved blank falls back to the default instead of sending an empty push.
    const value = row?.value?.trim() ? row.value : null;
    setCache(key, value);
    return interpolate(value ?? fallback, vars);
  } catch {
    return interpolate(fallback, vars);
  }
}

/**
 * TAFSD-513: a notification's title and body from its templates
 * (`<base>_title`, `<base>_body`), or null when it's switched off on the
 * Notification Templates page (`<base>_disabled`).
 */
export async function renderNotification(
  prisma: PrismaService,
  base: string,
  fallback: { title: string; body: string },
  vars: Record<string, string> = {},
): Promise<{ title: string; body: string } | null> {
  const titleKey = `${base}_title`;
  if (await isTemplateDisabled(prisma, titleKey)) return null;
  const [title, body] = await Promise.all([
    resolveTemplate(prisma, titleKey, fallback.title, vars),
    resolveTemplate(prisma, `${base}_body`, fallback.body, vars),
  ]);
  return { title, body };
}

/** " Reason: …" (or another label) when there is text, else "", for `{…_clause}` variables. */
export const clause = (label: string, text: string | null | undefined) =>
  text?.trim() ? ` ${label}: ${text.trim()}` : '';

/** TAFSD-514: shared by the Saturday schedule and staff calendar paths. */
export const SATURDAY_CLASH_FALLBACK = {
  title: 'Attendance Required Despite Day Off',
  body: 'You have a day off marked for {dates}, but a mandatory Saturday assignment takes priority — please check in as usual.',
};
