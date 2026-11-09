import { Prisma } from '@prisma/client';

/**
 * TAFSD-484: breaks entered on a manual attendance override. Stored on
 * attendance_staff_daily.manual_breaks as a JSON array; times are wall-clock
 * values in UTC fields, like check_in_at / check_out_at.
 *
 * null means the override says nothing about breaks, so the punch-derived
 * breaks still apply (the behaviour before this existed). An empty array
 * means HR recorded the day as having no breaks.
 */
export interface ManualBreak {
  start: string;
  end: string;
  reason: string | null;
}

export const MAX_MANUAL_BREAKS = 10;

export function parseManualBreaks(value: Prisma.JsonValue | null | undefined): ManualBreak[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((b): b is Prisma.JsonObject => !!b && typeof b === 'object' && !Array.isArray(b))
    .filter((b) => typeof b.start === 'string' && typeof b.end === 'string')
    .map((b) => ({
      start: b.start as string,
      end: b.end as string,
      reason: typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim() : null,
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function manualBreakMinutes(breaks: ManualBreak[]): number {
  return breaks.reduce(
    (sum, b) => sum + Math.max(0, Math.round((new Date(b.end).getTime() - new Date(b.start).getTime()) / 60000)),
    0,
  );
}

type Segment = { type: 'WORK' | 'BREAK'; start: string; end: string; reason?: string | null };

/** The overridden day's bar: work from check-in to check-out, cut by each break. */
export function manualDaySegments(checkIn: Date, checkOut: Date | null, breaks: ManualBreak[] | null): Segment[] {
  const start = checkIn.toISOString();
  const end = checkOut ? checkOut.toISOString() : start;
  if (!breaks?.length || !checkOut) return [{ type: 'WORK', start, end }];
  const segments: Segment[] = [];
  let cursor = start;
  for (const b of breaks) {
    if (b.start > cursor) segments.push({ type: 'WORK', start: cursor, end: b.start });
    segments.push({ type: 'BREAK', start: b.start, end: b.end, reason: b.reason });
    cursor = b.end;
  }
  if (end > cursor) segments.push({ type: 'WORK', start: cursor, end });
  return segments;
}

/**
 * Turns "HH:mm" breaks for one date into stored breaks, or explains what is
 * wrong with them. Each break must end after it starts, breaks must not
 * overlap, and they must sit inside the check-in / check-out when those are
 * known.
 */
export function buildManualBreaks(
  date: Date,
  input: { start_time: string; end_time: string; reason?: string | null }[],
  checkIn: Date | null,
  checkOut: Date | null,
): { breaks: ManualBreak[] } | { error: string } {
  if (input.length > MAX_MANUAL_BREAKS) return { error: `At most ${MAX_MANUAL_BREAKS} breaks a day.` };
  const at = (hm: string) => {
    const [h, m] = hm.split(':').map(Number);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, m, 0));
  };
  const hm = (d: Date) => d.toISOString().slice(11, 16);
  const breaks = input
    .map((b) => ({ start: at(b.start_time), end: at(b.end_time), reason: b.reason?.trim() || null }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const [i, b] of breaks.entries()) {
    if (b.end <= b.start) return { error: `A break must end after it starts (${hm(b.start)}–${hm(b.end)}).` };
    if (checkIn && b.start < checkIn) return { error: `A break can't start before the check-in at ${hm(checkIn)}.` };
    if (checkOut && b.end > checkOut) return { error: `A break can't end after the check-out at ${hm(checkOut)}.` };
    const prev = breaks[i - 1];
    if (prev && b.start < prev.end) return { error: `Breaks overlap (${hm(prev.start)}–${hm(prev.end)} and ${hm(b.start)}–${hm(b.end)}).` };
  }
  return { breaks: breaks.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString(), reason: b.reason })) };
}
