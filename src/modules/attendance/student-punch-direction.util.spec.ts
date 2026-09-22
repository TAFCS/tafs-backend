import { ScanDirection } from '@prisma/client';
import {
  resolveStudentDayPunches,
  nextStudentDirection,
  shouldAnnouncePunch,
  secondsOfDay,
  buildStudentSessions,
} from './student-punch-direction.util';

/** A punch at a wall-clock time, in the naive-local convention scan_time uses. */
const at = (hhmm: string) => {
  const [h, m, s] = hhmm.split(':').map(Number);
  return { scan_time: new Date(Date.UTC(2026, 8, 22, h, m, s ?? 0)) };
};

/** A `@db.Time` column as Prisma hands it back. */
const time = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(1970, 0, 1, h, m, 0));
};

const INTERMEDIATE = time('11:30');
const IN = ScanDirection.IN;
const OUT = ScanDirection.OUT;

describe('resolveStudentDayPunches', () => {
  describe('rule 1 — nothing before the intermediate time is a departure', () => {
    it('a single morning punch is the check-in, with no check-out', () => {
      const r = resolveStudentDayPunches([at('07:55')], INTERMEDIATE);
      expect(r.directions).toEqual([IN]);
      expect(r.checkInAt).toEqual(at('07:55').scan_time);
      expect(r.checkOutAt).toBeNull();
      expect(r.checkOutOnly).toBe(false);
    });

    it('a double punch at the gate does NOT record a clock-out', () => {
      const r = resolveStudentDayPunches([at('07:55'), at('07:58')], INTERMEDIATE);
      expect(r.directions).toEqual([IN, IN]);
      expect(r.checkInAt).toEqual(at('07:55').scan_time);
      expect(r.checkOutAt).toBeNull();
    });

    it('holds for many morning punches, however far apart', () => {
      const r = resolveStudentDayPunches(
        [at('07:40'), at('08:10'), at('09:05'), at('11:29:59')],
        INTERMEDIATE,
      );
      expect(r.directions).toEqual([IN, IN, IN, IN]);
      expect(r.checkOutAt).toBeNull();
      expect(r.scanCount).toBe(4);
      expect(r.lastScanAt).toEqual(at('11:29:59').scan_time);
    });
  });

  describe('rule 2 — the first punch after the intermediate time is a clock-out', () => {
    it('pairs a morning arrival with an afternoon departure', () => {
      const r = resolveStudentDayPunches([at('07:55'), at('13:40')], INTERMEDIATE);
      expect(r.directions).toEqual([IN, OUT]);
      expect(r.checkInAt).toEqual(at('07:55').scan_time);
      expect(r.checkOutAt).toEqual(at('13:40').scan_time);
      expect(r.checkOutOnly).toBe(false);
    });

    it('records a clock-out even when the child never punched in', () => {
      const r = resolveStudentDayPunches([at('13:40')], INTERMEDIATE);
      expect(r.directions).toEqual([OUT]);
      expect(r.checkInAt).toBeNull();
      expect(r.checkOutAt).toEqual(at('13:40').scan_time);
      expect(r.checkOutOnly).toBe(true);
    });

    it('a punch exactly on the intermediate time is already a clock-out', () => {
      const r = resolveStudentDayPunches([at('07:55'), at('11:30:00')], INTERMEDIATE);
      expect(r.directions).toEqual([IN, OUT]);
      expect(r.checkOutAt).toEqual(at('11:30:00').scan_time);
    });

    it('a second morning punch still does not become the clock-out when a later one exists', () => {
      const r = resolveStudentDayPunches([at('07:55'), at('07:58'), at('13:40')], INTERMEDIATE);
      expect(r.directions).toEqual([IN, IN, OUT]);
      expect(r.checkInAt).toEqual(at('07:55').scan_time);
      expect(r.checkOutAt).toEqual(at('13:40').scan_time);
    });
  });

  describe('rule 3 — alternation resumes after the departure', () => {
    it('a child who leaves and returns produces a break pair', () => {
      const r = resolveStudentDayPunches(
        [at('07:55'), at('13:40'), at('14:10'), at('15:30')],
        INTERMEDIATE,
      );
      expect(r.directions).toEqual([IN, OUT, IN, OUT]);
      expect(r.checkInAt).toEqual(at('07:55').scan_time);
      // Most recent OUT wins — the 13:40 departure becomes a break-out.
      expect(r.checkOutAt).toEqual(at('15:30').scan_time);
    });

    it('an unclosed return leaves the earlier departure as the check-out', () => {
      const r = resolveStudentDayPunches([at('07:55'), at('13:40'), at('14:10')], INTERMEDIATE);
      expect(r.directions).toEqual([IN, OUT, IN]);
      expect(r.checkOutAt).toEqual(at('13:40').scan_time);
    });

    it('alternates from the departure even on a check-out-only day', () => {
      const r = resolveStudentDayPunches([at('13:40'), at('14:10'), at('15:30')], INTERMEDIATE);
      expect(r.directions).toEqual([OUT, IN, OUT]);
      expect(r.checkInAt).toBeNull();
      expect(r.checkOutAt).toEqual(at('15:30').scan_time);
    });
  });

  describe('no intermediate time configured — legacy parity is unchanged', () => {
    it.each([null, undefined])('treats %s as parity', (intermediate) => {
      const r = resolveStudentDayPunches(
        [at('07:55'), at('07:58'), at('13:40')],
        intermediate as null | undefined,
      );
      expect(r.directions).toEqual([IN, OUT, IN]);
      expect(r.checkInAt).toEqual(at('07:55').scan_time);
      // Odd count under parity -> last OUT is the middle punch, exactly as before.
      expect(r.checkOutAt).toEqual(at('07:58').scan_time);
    });

    it('matches the old lastOutIdx for an even count', () => {
      const r = resolveStudentDayPunches([at('07:55'), at('13:40')], null);
      expect(r.checkOutAt).toEqual(at('13:40').scan_time);
    });
  });

  it('an empty day resolves to nothing at all', () => {
    const r = resolveStudentDayPunches([], INTERMEDIATE);
    expect(r).toMatchObject({
      directions: [],
      checkInAt: null,
      checkOutAt: null,
      lastScanAt: null,
      scanCount: 0,
      checkOutOnly: false,
    });
  });

  it('compares on wall clock, not on the date the punch fell on', () => {
    const early = { scan_time: new Date(Date.UTC(2020, 0, 1, 8, 0, 0)) };
    const late = { scan_time: new Date(Date.UTC(2030, 11, 31, 14, 0, 0)) };
    expect(resolveStudentDayPunches([early, late], INTERMEDIATE).directions).toEqual([IN, OUT]);
  });
});

describe('nextStudentDirection', () => {
  it('is always IN before the intermediate time, whatever the count', () => {
    expect(nextStudentDirection([], INTERMEDIATE, at('07:50').scan_time)).toBe(IN);
    expect(nextStudentDirection([at('07:55')], INTERMEDIATE, at('07:58').scan_time)).toBe(IN);
    expect(
      nextStudentDirection([at('07:55'), at('07:58')], INTERMEDIATE, at('09:00').scan_time),
    ).toBe(IN);
  });

  it('is OUT for the first punch after the intermediate time, even on an empty day', () => {
    expect(nextStudentDirection([], INTERMEDIATE, at('13:40').scan_time)).toBe(OUT);
    expect(nextStudentDirection([at('07:55')], INTERMEDIATE, at('13:40').scan_time)).toBe(OUT);
  });

  it('alternates once the departure is recorded', () => {
    const day = [at('07:55'), at('13:40')];
    expect(nextStudentDirection(day, INTERMEDIATE, at('14:10').scan_time)).toBe(IN);
    expect(
      nextStudentDirection([...day, at('14:10')], INTERMEDIATE, at('15:30').scan_time),
    ).toBe(OUT);
  });

  it('falls back to parity with no intermediate time', () => {
    expect(nextStudentDirection([], null, at('13:40').scan_time)).toBe(IN);
    expect(nextStudentDirection([at('07:55')], null, at('07:58').scan_time)).toBe(OUT);
  });
});

describe('shouldAnnouncePunch', () => {
  it('announces the arrival but stays quiet for the re-tap', () => {
    const r = resolveStudentDayPunches([at('07:55'), at('07:58'), at('09:05')], INTERMEDIATE);
    expect(shouldAnnouncePunch(r, 0)).toBe(true);
    expect(shouldAnnouncePunch(r, 1)).toBe(false);
    expect(shouldAnnouncePunch(r, 2)).toBe(false);
  });

  it('always announces a departure', () => {
    const r = resolveStudentDayPunches([at('07:55'), at('07:58'), at('13:40')], INTERMEDIATE);
    expect(shouldAnnouncePunch(r, 2)).toBe(true);
  });

  it('announces a return after a departure — the state genuinely changed', () => {
    const r = resolveStudentDayPunches([at('07:55'), at('13:40'), at('14:10')], INTERMEDIATE);
    expect(shouldAnnouncePunch(r, 2)).toBe(true);
  });

  it('announces a check-out-only day', () => {
    const r = resolveStudentDayPunches([at('13:40')], INTERMEDIATE);
    expect(shouldAnnouncePunch(r, 0)).toBe(true);
  });

  it('refuses an out-of-range index rather than guessing', () => {
    const r = resolveStudentDayPunches([at('07:55')], INTERMEDIATE);
    expect(shouldAnnouncePunch(r, -1)).toBe(false);
    expect(shouldAnnouncePunch(r, 5)).toBe(false);
  });
});

describe('secondsOfDay', () => {
  it('reads the wall clock off a naive-local timestamp', () => {
    expect(secondsOfDay(at('11:30:15').scan_time)).toBe(11 * 3600 + 30 * 60 + 15);
  });

  it('reads a Prisma Time column the same way', () => {
    expect(secondsOfDay(time('11:30'))).toBe(11 * 3600 + 30 * 60);
  });
});

describe('buildStudentSessions', () => {
  const sessions = (times: string[], intermediate: Date | null = INTERMEDIATE) =>
    buildStudentSessions(resolveStudentDayPunches(times.map(at), intermediate));

  it('folds a morning re-tap into the session already open', () => {
    expect(sessions(['07:55', '07:58'])).toEqual([
      { clock_in: at('07:55').scan_time, clock_out: null },
    ]);
  });

  it('closes that same session with the afternoon departure', () => {
    expect(sessions(['07:55', '07:58', '13:40'])).toEqual([
      { clock_in: at('07:55').scan_time, clock_out: at('13:40').scan_time },
    ]);
  });

  it('reports a departure with no arrival as an open-ended session', () => {
    expect(sessions(['13:40'])).toEqual([{ clock_in: null, clock_out: at('13:40').scan_time }]);
  });

  it('splits a leave-and-return into two sessions', () => {
    expect(sessions(['07:55', '13:40', '14:10', '15:30'])).toEqual([
      { clock_in: at('07:55').scan_time, clock_out: at('13:40').scan_time },
      { clock_in: at('14:10').scan_time, clock_out: at('15:30').scan_time },
    ]);
  });

  it('leaves a still-inside student with an unclosed session', () => {
    expect(sessions(['07:55', '13:40', '14:10'])).toEqual([
      { clock_in: at('07:55').scan_time, clock_out: at('13:40').scan_time },
      { clock_in: at('14:10').scan_time, clock_out: null },
    ]);
  });

  it('is empty for a day with no punches', () => {
    expect(sessions([])).toEqual([]);
  });

  it('pairs by parity when no intermediate time is configured', () => {
    expect(sessions(['07:55', '07:58', '13:40'], null)).toEqual([
      { clock_in: at('07:55').scan_time, clock_out: at('07:58').scan_time },
      { clock_in: at('13:40').scan_time, clock_out: null },
    ]);
  });
});
