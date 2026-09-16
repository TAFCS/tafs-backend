import { checkIsALevel, studentGrFormatError, studentGrPrefixForCampus } from './gr-number.util';

describe('checkIsALevel', () => {
  it('returns true for A-Level academic system', () => {
    expect(checkIsALevel('A-Level', 'AS Level')).toBe(true);
    expect(checkIsALevel('GCE A Level', 'A2 Level')).toBe(true);
  });

  it('returns false for Cambridge early-years / primary (not A-Level)', () => {
    expect(checkIsALevel('Cambridge', 'NUR')).toBe(false);
    expect(checkIsALevel('Cambridge', 'JR-I')).toBe(false);
    expect(checkIsALevel('Cambridge', 'PN')).toBe(false);
  });

  it('returns false for Secondary', () => {
    expect(checkIsALevel('Secondary', 'VIII')).toBe(false);
  });

  it('returns true when alevel_details are present', () => {
    expect(checkIsALevel('Cambridge', 'NUR', true)).toBe(true);
  });

  it('returns true for AS/A2 grade without explicit system', () => {
    expect(checkIsALevel(null, 'AS Level')).toBe(true);
    expect(checkIsALevel(undefined, 'A2 Level')).toBe(true);
  });
});

describe('studentGrPrefixForCampus', () => {
  it('does not use employee-style prefixes for Johar', () => {
    expect(studentGrPrefixForCampus('JOHAR CAMPUS', 1, false)).toBe('');
  });

  it('uses KF-A for Kaneez Fatima', () => {
    expect(studentGrPrefixForCampus('KANEEZ FATIMA CAMPUS', 2, false)).toBe('KF-A');
  });
});

describe('studentGrFormatError', () => {
  it('rejects employee-style GEJ on numeric Johar campus', () => {
    expect(studentGrFormatError('GEJ1', 'JOHAR', 1, false)).toMatch(/employee code/i);
    expect(studentGrFormatError('6581', 'JOHAR', 1, false)).toBeNull();
  });
});
