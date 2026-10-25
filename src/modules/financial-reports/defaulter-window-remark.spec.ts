import { defaulterWindowRemarks, formatMonthRuns } from './defaulter-window-remark';

const m = (year: number, month: number) => year * 12 + (month - 1);

describe('defaulter window remarks (TAFSD-418)', () => {
  it('collapses consecutive months and keeps the year once per range', () => {
    expect(formatMonthRuns([m(2026, 5), m(2026, 6), m(2026, 7), m(2026, 11)])).toBe('MAY–JUL 26, NOV 26');
    expect(formatMonthRuns([m(2026, 12), m(2027, 1)])).toBe('DEC 26–JAN 27');
    expect(formatMonthRuns([m(2026, 3)])).toBe('MAR 26');
  });

  const window = { lo: m(2026, 8), hi: m(2026, 10) };

  it('says nothing when every owed month is inside the window', () => {
    expect(defaulterWindowRemarks([m(2026, 8), m(2026, 10)], window)).toEqual([]);
  });

  it('explains LATER as missed money billed in advance', () => {
    expect(defaulterWindowRemarks([m(2026, 10), m(2026, 11), m(2026, 12)], window)).toEqual([
      'LATER = NOV–DEC 26: BILLED IN ADVANCE, NOT PAID — CARRIED TO NEXT VOUCHER AS ARREARS',
    ]);
  });

  it('explains EARLIER, before LATER', () => {
    expect(defaulterWindowRemarks([m(2026, 12), m(2026, 1)], window)).toEqual([
      'EARLIER = JAN 26: UNPAID FROM BEFORE AUG 26',
      'LATER = DEC 26: BILLED IN ADVANCE, NOT PAID — CARRIED TO NEXT VOUCHER AS ARREARS',
    ]);
  });
});
