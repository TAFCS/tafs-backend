import { parseSearchTerms } from './audit-logs.service';

describe('parseSearchTerms', () => {
  it('returns nothing for blank input', () => {
    expect(parseSearchTerms('')).toEqual([]);
    expect(parseSearchTerms('   ')).toEqual([]);
  });

  it('splits bare words into one term each, so they AND', () => {
    expect(parseSearchTerms('voucher deleted')).toEqual([
      { key: null, value: 'voucher' },
      { key: null, value: 'deleted' },
    ]);
  });

  it('reads a known key:value prefix', () => {
    expect(parseSearchTerms('entity:VOUCHER action:DELETED')).toEqual([
      { key: 'entity', value: 'VOUCHER' },
      { key: 'action', value: 'DELETED' },
    ]);
  });

  it('lowercases the key but leaves the value alone', () => {
    expect(parseSearchTerms('Entity:Voucher')).toEqual([
      { key: 'entity', value: 'Voucher' },
    ]);
  });

  it('keeps a quoted phrase as one term', () => {
    expect(parseSearchTerms('note:"marked as left"')).toEqual([
      { key: 'note', value: 'marked as left' },
    ]);
    expect(parseSearchTerms('"monthly pay"')).toEqual([
      { key: null, value: 'monthly pay' },
    ]);
  });

  it('treats an unknown prefix as literal text', () => {
    // Otherwise `03-0049` or a pasted URL would silently match everything.
    expect(parseSearchTerms('http://example.com/x')).toEqual([
      { key: null, value: 'http://example.com/x' },
    ]);
    expect(parseSearchTerms('colour:red')).toEqual([
      { key: null, value: 'colour:red' },
    ]);
  });

  it('mixes keyed and bare terms', () => {
    expect(parseSearchTerms('actor:umer monthly_pay')).toEqual([
      { key: 'actor', value: 'umer' },
      { key: null, value: 'monthly_pay' },
    ]);
  });

  it('drops a key with an empty quoted value', () => {
    expect(parseSearchTerms('note:""')).toEqual([]);
  });
});
