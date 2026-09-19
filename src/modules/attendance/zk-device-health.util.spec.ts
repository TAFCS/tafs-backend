import {
  classifyDevice,
  isExpectedWindow,
  windowStart,
} from './zk-device-health.util';

/** PKT wall clock -> instant. 2026-09-14 is a Monday, -19 Saturday, -20 Sunday. */
const pkt = (day: number, hh: number, mm = 0) =>
  new Date(Date.UTC(2026, 8, day, hh, mm) - 5 * 3600 * 1000);
const MON = 14;
const SAT = 19;
const SUN = 20;

describe('isExpectedWindow', () => {
  it('is never expected on Sunday', () => {
    expect(isExpectedWindow(pkt(SUN, 10), true)).toBe(false);
  });

  it('covers 06:00 inclusive to 18:00 exclusive on a weekday', () => {
    expect(isExpectedWindow(pkt(MON, 5, 59), false)).toBe(false);
    expect(isExpectedWindow(pkt(MON, 6, 0), false)).toBe(true);
    expect(isExpectedWindow(pkt(MON, 17, 59), false)).toBe(true);
    expect(isExpectedWindow(pkt(MON, 18, 0), false)).toBe(false);
  });

  it('on Saturday expects only Saturday-active devices', () => {
    expect(isExpectedWindow(pkt(SAT, 10), true)).toBe(true);
    expect(isExpectedWindow(pkt(SAT, 10), false)).toBe(false);
  });
});

describe('classifyDevice', () => {
  const now = pkt(MON, 12);
  const ago = (min: number) => new Date(now.getTime() - min * 60000);

  it.each([
    [14, 'ok'],
    [15, 'warn'],
    [59, 'warn'],
    [60, 'alert'],
    [119, 'alert'],
    [120, 'critical'],
  ])('%i min of silence is %s', (min, state) => {
    expect(classifyDevice(now, ago(min), false).state).toBe(state);
  });

  it('is never when a device has not been seen during the window', () => {
    expect(classifyDevice(now, null, false).state).toBe('never');
  });

  it('does not count overnight silence: at 06:10 a device last seen yesterday is ok', () => {
    const early = pkt(MON, 6, 10);
    expect(classifyDevice(early, pkt(MON - 1, 17, 0), false).state).toBe('ok');
    expect(windowStart(early).getTime()).toBe(pkt(MON, 6, 0).getTime());
  });

  it('reports the real minutes since last contact even when clamped', () => {
    expect(classifyDevice(pkt(MON, 6, 10), pkt(MON - 1, 17, 0), false).minutes_since).toBe(13 * 60 + 10);
  });

  it('is off_hours (with reason) outside the window, however stale', () => {
    expect(classifyDevice(pkt(SUN, 10), ago(5000), true)).toMatchObject({
      state: 'off_hours',
      not_expected_reason: 'sunday',
    });
    expect(classifyDevice(pkt(MON, 20), null, true).not_expected_reason).toBe('after_hours');
    expect(classifyDevice(pkt(SAT, 10), null, false)).toMatchObject({
      state: 'off_hours',
      not_expected_reason: 'saturday',
    });
    expect(classifyDevice(pkt(SAT, 10), null, true).state).toBe('never');
  });
});
