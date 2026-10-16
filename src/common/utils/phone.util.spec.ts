import { formatPkPhone, normalizePkPhone } from './phone.util';

describe('phone.util', () => {
  it.each([
    ['3122244523', '03122244523'],
    ['03122244523', '03122244523'],
    ['+923122244523', '03122244523'],
    ['923122244523', '03122244523'],
    ['00923122244523', '03122244523'],
    ['0312-2244523', '03122244523'],
    ['(021) 34567890', '02134567890'],
    ['N/A', ''],
    ['021-N/A', ''],
    ['', ''],
    [null, ''],
  ])('normalizes %p to %p', (raw, expected) => {
    expect(normalizePkPhone(raw)).toBe(expected);
  });

  it('formats local numbers with a dash after the prefix', () => {
    expect(formatPkPhone('+923323442733')).toBe('0332-3442733');
    expect(formatPkPhone('02134567890')).toBe('0213-4567890');
    expect(formatPkPhone('12345')).toBe('');
    expect(formatPkPhone('4412345678')).toBe('4412345678');
    expect(formatPkPhone(undefined)).toBe('');
  });
});
