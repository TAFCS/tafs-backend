export const AUDIT_ACTOR_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Human-readable labels for non-user system actors stored in audit_logs.changed_by. */
export const AUDIT_SYSTEM_ACTOR_LABELS: Record<string, string> = {
  'zk-device': 'ZK Device',
  system: 'System',
  'meezan-bank': 'Meezan Bank',
};

export type AuditActorSource = {
  sub?: string | null;
  username?: string | null;
  full_name?: string | null;
  fullName?: string | null;
};

/**
 * Value to persist in audit_logs.changed_by.
 * Prefer full name, then login username; fall back to sub only when nothing else exists.
 */
export function auditActorLabel(source?: AuditActorSource | string | null): string {
  if (source == null) return 'system';

  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (!trimmed) return 'system';
    return AUDIT_SYSTEM_ACTOR_LABELS[trimmed] ?? trimmed;
  }

  const fullName = source.full_name?.trim() || source.fullName?.trim();
  if (fullName) return fullName;

  const username = source.username?.trim();
  if (username) return username;

  const sub = source.sub?.trim();
  if (sub) return sub;

  return 'system';
}

/** Resolve stored changed_by to a display label (UUID → user name when known). */
export function resolveAuditActorDisplay(
  changedBy: string,
  userById: Map<string, { full_name: string; username: string }>,
  userByUsername: Map<string, { full_name: string; username: string }>,
): string {
  const systemLabel = AUDIT_SYSTEM_ACTOR_LABELS[changedBy];
  if (systemLabel) return systemLabel;

  if (AUDIT_ACTOR_UUID_RE.test(changedBy)) {
    const user = userById.get(changedBy);
    if (user) return user.full_name?.trim() || user.username;
  } else {
    const user = userByUsername.get(changedBy);
    if (user) return user.full_name?.trim() || user.username;
  }

  return changedBy;
}
