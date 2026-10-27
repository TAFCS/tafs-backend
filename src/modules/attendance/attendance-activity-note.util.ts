import { AUDIT_SYSTEM_ACTOR_LABELS } from '../../common/utils/audit-actor.util';

export interface BuildAttendanceActivityNoteInput {
  personName: string;
  date: Date;
  status: string;
  checkInAt?: Date | null;
  checkOutAt?: Date | null;
  lastScanAt?: Date | null;
  scanCount: number;
  expectedCheckIn?: Date | null;
  previousStatus?: string | null;
  previousCheckInAt?: Date | null;
  previousCheckOutAt?: Date | null;
  changedBy?: string | null;
  actorName?: string | null;
  now?: Date;
  isUtcInstant?: boolean;
}

export function formatPersonName(name: string): string {
  const trimmed = name?.trim();
  if (!trimmed) return trimmed ?? '';
  // If ALL CAPS or all lower, convert to Title Case
  if (trimmed === trimmed.toUpperCase() || trimmed === trimmed.toLowerCase()) {
    return trimmed
      .toLowerCase()
      .split(/\s+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
  return trimmed;
}

export function formatStatusLabel(status: string): string {
  if (!status) return '';
  return status
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function formatPunchTime(date: Date, options?: { isUtcInstant?: boolean }): string {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: options?.isUtcInstant ? 'Asia/Karachi' : 'UTC',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

export function formatPktDay(date: Date): string {
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  return `${parts.weekday} ${parts.day} ${parts.month}`;
}

export function getTodayKeyKarachi(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getDateKeyKarachi(date: Date): string {
  return getTodayKeyKarachi(date);
}

/**
 * Builds clear, human-readable attendance activity notes.
 *
 * Example copies:
 * - First scan: "**Shakeela checked in at 8:14 AM** · Late (due 8:00 AM)"
 * - Check-out: "**Shakeela checked out at 2:05 PM** · in at 8:14 AM"
 * - Extra scan: "**Shakeela scanned again at 2:40 PM** · check-out moved to 2:40 PM"
 * - Status change: " · status changed from Present to Late"
 * - Manual entry: "**Ali Raza checked in at 7:45 AM** · Present · entered by Hassan Khan"
 * - Not today: " · Thu 16 Oct"
 */
export function buildAttendanceActivityNote(input: BuildAttendanceActivityNoteInput): string {
  const {
    personName,
    date,
    status,
    checkInAt,
    checkOutAt,
    lastScanAt,
    scanCount,
    expectedCheckIn,
    previousStatus,
    previousCheckOutAt,
    changedBy,
    actorName,
    now = new Date(),
    isUtcInstant = false,
  } = input;

  const name = formatPersonName(personName);
  const timeOpts = { isUtcInstant };
  const currentStatusFormatted = formatStatusLabel(status);
  const prevStatusFormatted = previousStatus ? formatStatusLabel(previousStatus) : null;

  let boldClause = '';
  const detailClauses: string[] = [];

  const isCheckOutOnly = !checkInAt && !!checkOutAt;
  const isFirstCheckOut = !!checkOutAt && (!previousCheckOutAt || scanCount === 2);
  const isFurtherCheckOut = !!checkOutAt && !!previousCheckOutAt && scanCount > 2;
  const isFurtherCheckIn = !checkOutAt && scanCount > 1;

  if (isFurtherCheckOut) {
    const scanTime = lastScanAt ?? checkOutAt;
    boldClause = `**${name} scanned again at ${formatPunchTime(scanTime, timeOpts)}**`;
    detailClauses.push(`check-out moved to ${formatPunchTime(checkOutAt, timeOpts)}`);
  } else if (isFirstCheckOut || isCheckOutOnly) {
    boldClause = `**${name} checked out at ${formatPunchTime(checkOutAt!, timeOpts)}**`;
    if (checkInAt) {
      detailClauses.push(`in at ${formatPunchTime(checkInAt, timeOpts)}`);
    }
  } else if (isFurtherCheckIn) {
    const scanTime = lastScanAt ?? checkInAt!;
    boldClause = `**${name} scanned again at ${formatPunchTime(scanTime, timeOpts)}**`;
  } else {
    // First scan of the day (check-in)
    const scanTime = checkInAt ?? lastScanAt ?? date;
    boldClause = `**${name} checked in at ${formatPunchTime(scanTime, timeOpts)}**`;
    if (currentStatusFormatted.toLowerCase() === 'late') {
      if (expectedCheckIn) {
        detailClauses.push(`Late (due ${formatPunchTime(expectedCheckIn, timeOpts)})`);
      } else {
        detailClauses.push('Late');
      }
    } else {
      detailClauses.push(currentStatusFormatted);
    }
  }

  // Status actually changed (only when different from previous)
  if (previousStatus && prevStatusFormatted !== currentStatusFormatted) {
    detailClauses.push(`status changed from ${prevStatusFormatted} to ${currentStatusFormatted}`);
  }

  // Manual entry attribution
  const isBiometric = !changedBy || changedBy === 'zk-device' || changedBy === 'Biometric device';
  if (!isBiometric) {
    const enteredByName = actorName || (changedBy ? AUDIT_SYSTEM_ACTOR_LABELS[changedBy] ?? changedBy : null);
    if (enteredByName) {
      detailClauses.push(`entered by ${enteredByName}`);
    }
  }

  // Date suffix if not today in PKT
  const todayKeyPkt = getTodayKeyKarachi(now);
  const dateKeyPkt = getDateKeyKarachi(date);
  if (dateKeyPkt !== todayKeyPkt) {
    detailClauses.push(formatPktDay(date));
  }

  return detailClauses.length > 0 ? `${boldClause} · ${detailClauses.join(' · ')}` : boldClause;
}
