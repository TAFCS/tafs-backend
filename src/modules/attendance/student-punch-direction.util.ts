import { ScanDirection } from '@prisma/client';

/**
 * How a student's punches become IN / OUT.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RULES — students only. Staff keep strict parity (see
 * ZkAttendanceProcessorService's header and Coral9AttendanceWriterService,
 * which must stay identical to Coral9's own implementation).
 *
 * Devices carry no in/out intent; the kid just taps. Historically the Nth tap
 * of the day was simply "IN if N is odd, OUT if N is even", which gets two
 * common cases wrong:
 *
 *   - A child taps twice at the morning gate (re-tap, curiosity, a friend
 *     pushing them back through). Parity called the second tap a departure and
 *     fired "Left School" at 08:02.
 *   - A child never taps in but taps on the way out. Parity called that single
 *     tap an arrival, so the day showed a check-in at home time and no
 *     departure at all.
 *
 * So each campus+class pairing carries an INTERMEDIATE TIME — an internal
 * threshold, never shown to parents — and direction is decided against it:
 *
 *   1. Every punch BEFORE the intermediate time is an IN. The first one is the
 *      check-in; the rest are re-taps that neither open nor close anything.
 *   2. The FIRST punch AT OR AFTER the intermediate time is an OUT — even when
 *      the child never punched in. That day has a check-out and no check-in,
 *      which is the truth and should read that way.
 *   3. Punches after that one resume alternating: IN, OUT, IN, … so a child who
 *      leaves and comes back still produces break pairs.
 *
 * A pairing with NO intermediate time configured (every row predating this
 * feature) falls back to the old parity, unchanged.
 * ---------------------------------------------------------------------------
 *
 * Everything that needs a student's direction, check-in or check-out goes
 * through here — the ingest pipeline, the recompute/rebuild path, the HR
 * dashboard's timeline, and the parent app's own read. They each used to
 * re-derive `% 2` independently, so any change to the rule that missed one of
 * them would have the stored row and the screen disagreeing.
 */

/** Minimal shape this operates on — anything with a scan time. */
export interface PunchLike {
  scan_time: Date;
}

export interface StudentDayPunches<T extends PunchLike = PunchLike> {
  /** Same order and length as the input. */
  directions: ScanDirection[];
  /** First punch of the day, but only when it is a genuine arrival. */
  checkInAt: Date | null;
  /** Most recent OUT — earlier OUTs become break-outs once a later pair exists. */
  checkOutAt: Date | null;
  lastScanAt: Date | null;
  scanCount: number;
  /**
   * True when the day has punches but none of them is an arrival — the child
   * only tapped on the way out. Callers that classify a day need this to avoid
   * reading a null check-in as "never came in".
   */
  checkOutOnly: boolean;
  punches: T[];
}

/**
 * Seconds since midnight, read off the naive-local wall clock.
 *
 * Both sides of every comparison here use the same convention: scan_time is
 * stored as the device's literal wall clock via Date.UTC (see
 * ZkAttendanceProcessorService.parseDeviceDateTime), and a Prisma `@db.Time`
 * column comes back as 1970-01-01T HH:MM:SS Z. Reading both with getUTC* is
 * what keeps them comparable regardless of the server's timezone.
 */
export function secondsOfDay(d: Date): number {
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
}

/** The pre-existing rule, kept verbatim for pairings with no intermediate time. */
function parityDirections(count: number): ScanDirection[] {
  return Array.from({ length: count }, (_, i) =>
    i % 2 === 0 ? ScanDirection.IN : ScanDirection.OUT,
  );
}

/**
 * @param punches Non-duplicate punches for ONE student on ONE day, ascending by
 *                scan_time. Duplicates must already be filtered — the dedup
 *                window is a device-retry filter and is not this rule's job.
 * @param intermediateTime The pairing's internal threshold, or null/undefined
 *                for the legacy parity behaviour.
 */
export function resolveStudentDayPunches<T extends PunchLike>(
  punches: T[],
  intermediateTime: Date | null | undefined,
): StudentDayPunches<T> {
  if (punches.length === 0) {
    return {
      directions: [],
      checkInAt: null,
      checkOutAt: null,
      lastScanAt: null,
      scanCount: 0,
      checkOutOnly: false,
      punches,
    };
  }

  let directions: ScanDirection[];
  let checkInAt: Date | null;

  if (!intermediateTime) {
    directions = parityDirections(punches.length);
    checkInAt = punches[0].scan_time;
  } else {
    const threshold = secondsOfDay(intermediateTime);
    // First punch at or after the threshold. -1 when the whole day is early.
    const pivot = punches.findIndex((p) => secondsOfDay(p.scan_time) >= threshold);

    if (pivot === -1) {
      // Rule 1 only: the child never punched after the threshold, so nothing
      // today is a departure however many times they tapped.
      directions = punches.map(() => ScanDirection.IN);
      checkInAt = punches[0].scan_time;
    } else {
      directions = punches.map((_, i) => {
        if (i < pivot) return ScanDirection.IN; // rule 1
        if (i === pivot) return ScanDirection.OUT; // rule 2
        // rule 3 — alternate away from the departure.
        return (i - pivot) % 2 === 1 ? ScanDirection.IN : ScanDirection.OUT;
      });
      // A day that opens with the departure punch has no arrival at all.
      checkInAt = pivot > 0 ? punches[0].scan_time : null;
    }
  }

  let checkOutAt: Date | null = null;
  for (let i = punches.length - 1; i >= 0; i--) {
    if (directions[i] === ScanDirection.OUT) {
      checkOutAt = punches[i].scan_time;
      break;
    }
  }

  return {
    directions,
    checkInAt,
    checkOutAt,
    lastScanAt: punches[punches.length - 1].scan_time,
    scanCount: punches.length,
    checkOutOnly: checkInAt === null && checkOutAt !== null,
    punches,
  };
}

/**
 * What the next punch of the day would be, for the gate desk — where the
 * operator picks IN or OUT explicitly and we reject a choice that would corrupt
 * the day's pairing.
 *
 * `at` is when the punch is being recorded (naive-local, as
 * ZkAttendanceProcessorService.nowAsDeviceTime produces). It matters: with an
 * intermediate time the answer depends on the clock, not just the count. Before
 * the threshold every punch is an arrival; the first one after it is always the
 * departure, even on an empty day.
 */
export function nextStudentDirection(
  punches: PunchLike[],
  intermediateTime: Date | null | undefined,
  at: Date,
): ScanDirection {
  if (!intermediateTime) {
    return punches.length % 2 === 0 ? ScanDirection.IN : ScanDirection.OUT;
  }

  const threshold = secondsOfDay(intermediateTime);
  if (secondsOfDay(at) < threshold) return ScanDirection.IN;

  const resolved = resolveStudentDayPunches([...punches, { scan_time: at }], intermediateTime);
  return resolved.directions[resolved.directions.length - 1];
}

/**
 * Whether a punch should raise an arrived/left push to the parent.
 *
 * Under parity every punch flipped the state, so every punch was worth
 * announcing. Under rule 1 it no longer is: the 2nd, 3rd … morning tap resolves
 * to IN like the first, and re-sending "Arrived at School" for each one is the
 * same spam the old "Left School at 08:02" was, pointing the other way.
 *
 * @param index Position of the punch within the day's non-duplicate punches.
 */
export function shouldAnnouncePunch(
  resolved: StudentDayPunches,
  index: number,
): boolean {
  if (index < 0 || index >= resolved.directions.length) return false;
  if (resolved.directions[index] !== ScanDirection.IN) return true;
  // Announce an arrival only if it is the first punch that resolved to IN in
  // this stretch — i.e. the state actually changed.
  return index === 0 || resolved.directions[index - 1] !== ScanDirection.IN;
}

/**
 * One in/out stretch of a student's day.
 *
 * Both ends are nullable, and each null means something specific:
 *   - `clock_in: null`  — the child only punched on the way out (rule 2).
 *   - `clock_out: null` — they are still inside, or never punched out.
 * A session is never null on both ends.
 */
export interface StudentSession {
  clock_in: Date | null;
  clock_out: Date | null;
}

/**
 * Collapse resolved punches into sessions.
 *
 * The consecutive INs that rule 1 produces are re-taps at the same gate, not a
 * second arrival, so they fold into the session already open rather than each
 * starting one. That is the whole point of the rule: the morning double punch
 * has to leave the day looking exactly like a single punch did.
 */
export function buildStudentSessions(resolved: StudentDayPunches): StudentSession[] {
  const sessions: StudentSession[] = [];
  let openedAt: Date | null = null;
  let isOpen = false;

  resolved.punches.forEach((punch, i) => {
    if (resolved.directions[i] === ScanDirection.IN) {
      if (isOpen) return; // re-tap — the session is already running
      openedAt = punch.scan_time;
      isOpen = true;
    } else {
      sessions.push({ clock_in: isOpen ? openedAt : null, clock_out: punch.scan_time });
      openedAt = null;
      isOpen = false;
    }
  });

  if (isOpen) sessions.push({ clock_in: openedAt, clock_out: null });
  return sessions;
}
