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
    setCache(key, row?.value ?? null);
    return interpolate(row?.value ?? fallback, vars);
  } catch {
    return interpolate(fallback, vars);
  }
}
