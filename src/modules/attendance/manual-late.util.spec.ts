import { effectiveManualStatus, isLateCheckIn } from './manual-late.util';

const t = (hm: string) => new Date(`2026-09-30T${hm}:00.000Z`);

describe('isLateCheckIn', () => {
  it('is on time within the grace window, late past it', () => {
    expect(isLateCheckIn(t('08:05'), t('08:00'), 5)).toBe(false);
    expect(isLateCheckIn(t('08:06'), t('08:00'), 5)).toBe(true);
    expect(isLateCheckIn(t('07:45'), t('08:00'), 0)).toBe(false);
  });
});

describe('effectiveManualStatus', () => {
  it('turns LATE with an on-time check-in into PRESENT', () => {
    expect(effectiveManualStatus('LATE', t('07:50'), t('08:00'), 10)).toBe('PRESENT');
  });

  it('keeps LATE when the check-in really is late', () => {
    expect(effectiveManualStatus('LATE', t('08:30'), t('08:00'), 10)).toBe('LATE');
  });

  it('keeps LATE when there is no time to judge by', () => {
    expect(effectiveManualStatus('LATE', null, t('08:00'), 10)).toBe('LATE');
    expect(effectiveManualStatus('LATE', t('07:50'), null, 10)).toBe('LATE');
  });

  it('never touches other statuses, including PRESENT with a late time', () => {
    expect(effectiveManualStatus('PRESENT', t('09:30'), t('08:00'), 10)).toBe('PRESENT');
    expect(effectiveManualStatus('HALF_DAY', t('07:50'), t('08:00'), 10)).toBe('HALF_DAY');
  });
});
