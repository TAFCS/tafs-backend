import { buildManualBreaks, manualBreakMinutes, manualDaySegments, parseManualBreaks } from './manual-breaks.util';

// TAFSD-484: breaks entered while overriding a staff member's day.
describe('manual override breaks', () => {
  const date = new Date('2026-11-05T00:00:00Z');
  const t = (hm: string) => new Date(`2026-11-05T${hm}:00.000Z`);

  it('builds sorted breaks and counts their minutes', () => {
    const built = buildManualBreaks(
      date,
      [
        { start_time: '13:00', end_time: '13:30', reason: ' Lunch ' },
        { start_time: '10:15', end_time: '10:40', reason: 'Bank' },
      ],
      t('08:00'),
      t('15:00'),
    );
    if ('error' in built) throw new Error(built.error);
    expect(built.breaks).toEqual([
      { start: '2026-11-05T10:15:00.000Z', end: '2026-11-05T10:40:00.000Z', reason: 'Bank' },
      { start: '2026-11-05T13:00:00.000Z', end: '2026-11-05T13:30:00.000Z', reason: 'Lunch' },
    ]);
    expect(manualBreakMinutes(built.breaks)).toBe(55);
  });

  it.each([
    [[{ start_time: '11:00', end_time: '11:00' }], 'must end after it starts'],
    [[{ start_time: '07:30', end_time: '08:30' }], 'before the check-in'],
    [[{ start_time: '14:30', end_time: '15:30' }], 'after the check-out'],
    [[{ start_time: '10:00', end_time: '11:00' }, { start_time: '10:30', end_time: '12:00' }], 'overlap'],
  ])('refuses %j', (input, message) => {
    const built = buildManualBreaks(date, input, t('08:00'), t('15:00'));
    expect('error' in built && built.error).toContain(message);
  });

  it('has no bounds to check without times', () => {
    const built = buildManualBreaks(date, [{ start_time: '07:00', end_time: '07:20' }], null, null);
    expect('breaks' in built && built.breaks).toHaveLength(1);
  });

  it('cuts the work bar at each break', () => {
    const breaks = parseManualBreaks([
      { start: '2026-11-05T13:00:00.000Z', end: '2026-11-05T13:30:00.000Z', reason: 'Lunch' },
      { start: '2026-11-05T10:15:00.000Z', end: '2026-11-05T10:40:00.000Z' },
    ]);
    expect(manualDaySegments(t('08:00'), t('15:00'), breaks).map((s) => `${s.type} ${s.start.slice(11, 16)}-${s.end.slice(11, 16)}`)).toEqual([
      'WORK 08:00-10:15',
      'BREAK 10:15-10:40',
      'WORK 10:40-13:00',
      'BREAK 13:00-13:30',
      'WORK 13:30-15:00',
    ]);
  });

  it('reads null as "no breaks entered" and [] as "none taken"', () => {
    expect(parseManualBreaks(null)).toBeNull();
    expect(parseManualBreaks([])).toEqual([]);
    expect(manualDaySegments(t('08:00'), t('15:00'), null)).toHaveLength(1);
  });
});
