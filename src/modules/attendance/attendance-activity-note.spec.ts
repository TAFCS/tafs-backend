import {
  buildAttendanceActivityNote,
  formatPersonName,
  formatPunchTime,
  formatPktDay,
  formatStatusLabel,
  getTodayKeyKarachi,
} from './attendance-activity-note.util';

describe('attendance-activity-note', () => {
  const at = (hhmm: string, day = 16) => {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(Date.UTC(2026, 9, day, h, m, 0));
  };
  const today = at('00:00');
  const now = today;
  const yesterday = at('00:00', 15);

  describe('formatPersonName', () => {
    it('converts ALL-CAPS names to Title Case', () => {
      expect(formatPersonName('SHAKEELA')).toBe('Shakeela');
      expect(formatPersonName('MUHAMMAD ALI')).toBe('Muhammad Ali');
    });

    it('converts all-lowercase names to Title Case', () => {
      expect(formatPersonName('shakeela')).toBe('Shakeela');
    });

    it('preserves already mixed-case names', () => {
      expect(formatPersonName('Ali Raza')).toBe('Ali Raza');
      expect(formatPersonName("McDonald")).toBe("McDonald");
    });
  });

  describe('formatStatusLabel', () => {
    it('formats enum status strings to Title Case', () => {
      expect(formatStatusLabel('PRESENT')).toBe('Present');
      expect(formatStatusLabel('LATE')).toBe('Late');
      expect(formatStatusLabel('HALF_DAY')).toBe('Half Day');
      expect(formatStatusLabel('ON_LEAVE')).toBe('On Leave');
    });
  });

  describe('first scan of the day', () => {
    it('formats on-time arrival as Present', () => {
      const note = buildAttendanceActivityNote({
        personName: 'SHAKEELA',
        date: today,
        status: 'PRESENT',
        checkInAt: at('07:55'),
        scanCount: 1,
        now,
      });
      expect(note).toBe('**Shakeela checked in at 7:55 AM** · Present');
    });

    it('formats late arrival with due time when expected check-in is known', () => {
      const note = buildAttendanceActivityNote({
        personName: 'SHAKEELA',
        date: today,
        status: 'LATE',
        checkInAt: at('08:14'),
        expectedCheckIn: at('08:00'),
        scanCount: 1,
        now,
      });
      expect(note).toBe('**Shakeela checked in at 8:14 AM** · Late (due 8:00 AM)');
    });

    it('formats late arrival without due time when expected check-in is null', () => {
      const note = buildAttendanceActivityNote({
        personName: 'SHAKEELA',
        date: today,
        status: 'LATE',
        checkInAt: at('08:14'),
        expectedCheckIn: null,
        scanCount: 1,
        now,
      });
      expect(note).toBe('**Shakeela checked in at 8:14 AM** · Late');
    });
  });

  describe('later scan (check-out)', () => {
    it('formats check-out with arrival time', () => {
      const note = buildAttendanceActivityNote({
        personName: 'SHAKEELA',
        date: today,
        status: 'LATE',
        checkInAt: at('08:14'),
        checkOutAt: at('14:05'),
        scanCount: 2,
        previousStatus: 'LATE',
        now,
      });
      expect(note).toBe('**Shakeela checked out at 2:05 PM** · in at 8:14 AM');
    });

    it('formats check-out only when check-in is missing', () => {
      const note = buildAttendanceActivityNote({
        personName: 'SHAKEELA',
        date: today,
        status: 'PRESENT',
        checkInAt: null,
        checkOutAt: at('14:05'),
        scanCount: 1,
        now,
      });
      expect(note).toBe('**Shakeela checked out at 2:05 PM**');
    });
  });

  describe('further scans after check-out (extra scan)', () => {
    it('formats moved check-out when person scans again after check-out', () => {
      const note = buildAttendanceActivityNote({
        personName: 'SHAKEELA',
        date: today,
        status: 'LATE',
        checkInAt: at('08:14'),
        checkOutAt: at('14:40'),
        lastScanAt: at('14:40'),
        scanCount: 3,
        previousStatus: 'LATE',
        previousCheckOutAt: at('14:05'),
        now,
      });
      expect(note).toBe('**Shakeela scanned again at 2:40 PM** · check-out moved to 2:40 PM');
    });

    it('formats extra morning scan before check-out', () => {
      const note = buildAttendanceActivityNote({
        personName: 'SHAKEELA',
        date: today,
        status: 'LATE',
        checkInAt: at('08:14'),
        checkOutAt: null,
        lastScanAt: at('08:20'),
        scanCount: 2,
        previousStatus: 'LATE',
        now,
      });
      expect(note).toBe('**Shakeela scanned again at 8:20 AM**');
    });
  });

  describe('real status change', () => {
    it('adds status change clause when status genuinely changed', () => {
      const note = buildAttendanceActivityNote({
        personName: 'SHAKEELA',
        date: today,
        status: 'LATE',
        checkInAt: at('08:14'),
        checkOutAt: at('14:05'),
        scanCount: 2,
        previousStatus: 'PRESENT',
        now,
      });
      expect(note).toBe(
        '**Shakeela checked out at 2:05 PM** · in at 8:14 AM · status changed from Present to Late',
      );
    });

    it('never outputs status changed clause or LATE->LATE when status is unchanged', () => {
      const note = buildAttendanceActivityNote({
        personName: 'SHAKEELA',
        date: today,
        status: 'LATE',
        checkInAt: at('08:14'),
        checkOutAt: at('14:05'),
        scanCount: 2,
        previousStatus: 'LATE',
        now,
      });
      expect(note).not.toContain('status changed');
      expect(note).not.toContain('LATE→LATE');
      expect(note).toBe('**Shakeela checked out at 2:05 PM** · in at 8:14 AM');
    });
  });

  describe('manual entry', () => {
    it('formats manual check-in with entering actor name', () => {
      const note = buildAttendanceActivityNote({
        personName: 'Ali Raza',
        date: today,
        status: 'PRESENT',
        checkInAt: at('07:45'),
        scanCount: 1,
        changedBy: 'Hassan Khan',
        now,
      });
      expect(note).toBe('**Ali Raza checked in at 7:45 AM** · Present · entered by Hassan Khan');
    });

    it('formats manual check-out with entering actor name', () => {
      const note = buildAttendanceActivityNote({
        personName: 'Ali Raza',
        date: today,
        status: 'PRESENT',
        checkInAt: at('07:45'),
        checkOutAt: at('14:05'),
        scanCount: 2,
        changedBy: 'Hassan Khan',
        now,
      });
      expect(note).toBe(
        '**Ali Raza checked out at 2:05 PM** · in at 7:45 AM · entered by Hassan Khan',
      );
    });
  });

  describe('missing check-out', () => {
    it('renders first check-in cleanly without expecting a check-out', () => {
      const note = buildAttendanceActivityNote({
        personName: 'SHAKEELA',
        date: today,
        status: 'LATE',
        checkInAt: at('08:14'),
        checkOutAt: null,
        expectedCheckIn: at('08:00'),
        scanCount: 1,
        now,
      });
      expect(note).toBe('**Shakeela checked in at 8:14 AM** · Late (due 8:00 AM)');
    });
  });

  describe('date suffix and punch near midnight UTC', () => {
    it('appends formatted PKT day when date is not today', () => {
      const note = buildAttendanceActivityNote({
        personName: 'SHAKEELA',
        date: yesterday,
        status: 'LATE',
        checkInAt: at('08:14'),
        expectedCheckIn: at('08:00'),
        scanCount: 1,
        now,
      });
      expect(note).toBe('**Shakeela checked in at 8:14 AM** · Late (due 8:00 AM) · Thu 15 Oct');
    });

    it('does not append day suffix when date is today', () => {
      const note = buildAttendanceActivityNote({
        personName: 'SHAKEELA',
        date: today,
        status: 'LATE',
        checkInAt: at('08:14'),
        expectedCheckIn: at('08:00'),
        scanCount: 1,
        now,
      });
      expect(note).not.toContain('Oct');
    });

    it('evaluates punch near midnight UTC using the PKT day', () => {
      // 2026-10-15 23:30:00 UTC is 2026-10-16 04:30:00 PKT (Asia/Karachi, UTC+5).
      const nearMidnightPunchUtc = new Date('2026-10-15T23:30:00.000Z');

      // formatPktDay returns the PKT day (Friday 16 Oct), not the UTC day (15 Oct)
      expect(formatPktDay(nearMidnightPunchUtc)).toBe('Fri 16 Oct');

      // When formatted with isUtcInstant: true, punch time is PKT (4:30 AM)
      expect(formatPunchTime(nearMidnightPunchUtc, { isUtcInstant: true })).toBe('4:30 AM');

      // When now is 2026-10-17, the note appends the PKT day
      const laterNow = new Date('2026-10-17T12:00:00.000Z');
      const note = buildAttendanceActivityNote({
        personName: 'SHAKEELA',
        date: nearMidnightPunchUtc,
        status: 'PRESENT',
        checkInAt: nearMidnightPunchUtc,
        scanCount: 1,
        isUtcInstant: true,
        now: laterNow,
      });
      expect(note).toBe('**Shakeela checked in at 4:30 AM** · Present · Fri 16 Oct');
    });
  });
});
