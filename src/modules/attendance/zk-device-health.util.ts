/**
 * Device heartbeat classification. Pure functions, no I/O.
 *
 * Silence only matters while a device is expected to be talking: Mon–Sat,
 * 06:00–18:00 PKT. On Saturdays only the faculty devices and TAFSAL are in
 * use, so every other device is not expected. Pakistan has no DST, so PKT is a
 * fixed UTC+5 and plain offset arithmetic is exact.
 */

export type DeviceHealthState = 'ok' | 'warn' | 'alert' | 'critical' | 'off_hours' | 'never';
export type NotExpectedReason = 'sunday' | 'saturday' | 'after_hours';

export interface ZkDeviceInfo {
  name: string;
  campusCode: string;
  /** Still in use on Saturdays (faculty devices + TAFSAL). */
  activeOnSaturday: boolean;
}

/** Keep in step with DEVICE_*_RULES in zk-attendance-mapping.service.ts and webapp zk-devices.ts. */
export const ZK_DEVICES: Record<string, ZkDeviceInfo> = {
  NYU7261205221: { name: 'Campus 2 Device 1 Secondary', campusCode: 'GEJ', activeOnSaturday: false },
  NYU7261205141: { name: 'Campus 2 Device 2 Senior Cambridge', campusCode: 'GEJ', activeOnSaturday: false },
  NYU7261205172: { name: 'TAFSAL', campusCode: 'GEJ', activeOnSaturday: true },
  NYU7261205142: { name: 'Campus 3 Device 1 Junior Cambridge', campusCode: 'GEJ', activeOnSaturday: false },
  NYU7261205128: { name: 'Campus 3 Device 2 Pre-Primary', campusCode: 'GEJ', activeOnSaturday: false },
  NYU7251000240: { name: 'Johar Faculty', campusCode: 'GEJ', activeOnSaturday: true },
  NYU7261000023: { name: 'NNN Faculty', campusCode: 'NNZ', activeOnSaturday: true },
  NYU7261205040: { name: 'GKF Faculty', campusCode: 'KNF', activeOnSaturday: true },
};

export const WINDOW_START_HOUR = 6;
export const WINDOW_END_HOUR = 18;

/** Minutes of silence at which each colour starts. */
export const WARN_MINUTES = 15;
export const ALERT_MINUTES = 60;
export const CRITICAL_MINUTES = 120;

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** A Date whose UTC getters read as Pakistan wall clock. */
function toPkt(instant: Date): Date {
  return new Date(instant.getTime() + PKT_OFFSET_MS);
}

/** Why `sn` is not expected to send anything at `now`, or null if it is expected. */
export function notExpectedReason(
  now: Date,
  activeOnSaturday: boolean,
): NotExpectedReason | null {
  const pkt = toPkt(now);
  const day = pkt.getUTCDay(); // 0 = Sunday
  if (day === 0) return 'sunday';
  const hour = pkt.getUTCHours();
  if (hour < WINDOW_START_HOUR || hour >= WINDOW_END_HOUR) return 'after_hours';
  if (day === 6 && !activeOnSaturday) return 'saturday';
  return null;
}

export function isExpectedWindow(now: Date, activeOnSaturday: boolean): boolean {
  return notExpectedReason(now, activeOnSaturday) === null;
}

/** The instant today's expected window opened (06:00 PKT of now's PKT date). */
export function windowStart(now: Date): Date {
  const pkt = toPkt(now);
  return new Date(
    Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), pkt.getUTCDate(), WINDOW_START_HOUR) -
      PKT_OFFSET_MS,
  );
}

export interface DeviceHealthResult {
  state: DeviceHealthState;
  expected_now: boolean;
  not_expected_reason: NotExpectedReason | null;
  /** Real minutes since last contact (null if never seen). Display value. */
  minutes_since: number | null;
}

export function classifyDevice(
  now: Date,
  lastContact: Date | null,
  activeOnSaturday: boolean,
): DeviceHealthResult {
  const reason = notExpectedReason(now, activeOnSaturday);
  const minutes_since = lastContact
    ? Math.max(0, Math.floor((now.getTime() - lastContact.getTime()) / MINUTE_MS))
    : null;

  if (reason) {
    return { state: 'off_hours', expected_now: false, not_expected_reason: reason, minutes_since };
  }
  if (!lastContact) {
    return { state: 'never', expected_now: true, not_expected_reason: null, minutes_since };
  }

  // Silence overnight or on a closed day shouldn't count against the device:
  // measure from whichever is later, its last contact or the window opening.
  const from = Math.max(lastContact.getTime(), windowStart(now).getTime());
  const silent = (now.getTime() - from) / MINUTE_MS;

  const state: DeviceHealthState =
    silent >= CRITICAL_MINUTES
      ? 'critical'
      : silent >= ALERT_MINUTES
        ? 'alert'
        : silent >= WARN_MINUTES
          ? 'warn'
          : 'ok';
  return { state, expected_now: true, not_expected_reason: null, minutes_since };
}
