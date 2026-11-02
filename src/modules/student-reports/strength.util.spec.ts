import {
  ageOn,
  buildStrengthGrid,
  genderOf,
  inCell,
  matchesCategoryFilters,
  sessionStartFor,
  splitValue,
  type StrengthStudent,
} from './strength.util';

const ctx = { today: '2026-11-01', sessionStart: '2026-08-01' };

let nextCc = 1;
const student = (over: Partial<StrengthStudent> = {}): StrengthStudent => ({
  cc: nextCc++,
  full_name: 'A',
  gr_number: null,
  campus_id: 1,
  campus: 'Gulistan',
  class_id: 5,
  class_name: 'Class 3',
  section_id: 10,
  section: 'A',
  house_id: 1,
  house: 'Red',
  gender: 'MALE',
  status: 'ENROLLED',
  dob: new Date('2018-03-15'),
  doa: new Date('2022-08-10'),
  discipline: null,
  segment_id: 2,
  segment: 'Junior',
  segment_order: 2,
  enrolled_siblings: 0,
  benefits: [],
  ...over,
});

describe('strength values', () => {
  it('folds free-text gender into Male / Female / Not set', () => {
    expect(['MALE', 'Male', 'm', 'Boy'].map((g) => genderOf(g).key)).toEqual([
      'MALE',
      'MALE',
      'MALE',
      'MALE',
    ]);
    expect(
      ['FEMALE', 'Female', 'f', 'girl'].map((g) => genderOf(g).key),
    ).toEqual(['FEMALE', 'FEMALE', 'FEMALE', 'FEMALE']);
    expect([null, '', 'other'].map((g) => genderOf(g).key)).toEqual([
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
    ]);
  });

  it('counts age in completed years, the day before a birthday included', () => {
    expect(ageOn(new Date('2018-11-01'), '2026-11-01')).toBe(8);
    expect(ageOn(new Date('2018-11-02'), '2026-11-01')).toBe(7);
    expect(ageOn(null, '2026-11-01')).toBeNull();
  });

  it('starts the session on 1 August', () => {
    expect(sessionStartFor('2026-11-01')).toBe('2026-08-01');
    expect(sessionStartFor('2027-07-31')).toBe('2026-08-01');
    expect(sessionStartFor('2027-08-01')).toBe('2027-08-01');
  });

  it('calls a student new when admitted this session, readmissions included', () => {
    expect(
      splitValue(student({ doa: new Date('2026-08-01') }), 'new_returning', ctx)
        .key,
    ).toBe('nr:new');
    expect(
      splitValue(student({ doa: new Date('2026-07-31') }), 'new_returning', ctx)
        .key,
    ).toBe('nr:returning');
    expect(splitValue(student({ doa: null }), 'new_returning', ctx).key).toBe(
      'nr:unknown',
    );
  });
});

describe('buildStrengthGrid', () => {
  const roll = [
    student({ gender: 'Male', house_id: 1, house: 'Red' }),
    student({ gender: 'FEMALE', house_id: 1, house: 'Red' }),
    student({
      gender: 'female',
      house_id: 2,
      house: 'Blue',
      section_id: 11,
      section: 'B',
    }),
    student({
      gender: 'M',
      house_id: null,
      house: null,
      class_id: 6,
      class_name: 'Class 4',
      section_id: 12,
      section: 'A',
    }),
    student({ campus_id: 2, campus: 'North Nazimabad', gender: 'F' }),
  ];

  it('nests campus, class and section rows, each level a subtotal of the one below', () => {
    const g = buildStrengthGrid(
      roll,
      { rows: 'section', split: 'gender' },
      ctx,
    );
    expect(g.rows.map((r) => [r.level, r.label, r.total])).toEqual([
      ['campus', 'Gulistan', 4],
      ['class', 'Class 3', 3],
      ['section', 'A', 2],
      ['section', 'B', 1],
      ['class', 'Class 4', 1],
      ['section', 'A', 1],
      ['campus', 'North Nazimabad', 1],
      ['class', 'Class 3', 1],
      ['section', 'A', 1],
    ]);
    expect(g.rows[1].counts).toEqual({ MALE: 1, FEMALE: 2 });
    expect(g.totals).toEqual({ counts: { MALE: 2, FEMALE: 3 }, total: 5 });
    expect(g.columns.map((c) => c.key)).toEqual(['MALE', 'FEMALE']);
  });

  it('crosses two splits with a total per value of the first', () => {
    const g = buildStrengthGrid(
      roll,
      { rows: 'campus', split: 'house', split2: 'gender' },
      ctx,
    );
    expect(g.columns.map((c) => `${c.group}/${c.label}`)).toEqual([
      'Blue/Male',
      'Blue/Female',
      'Blue/Total',
      'Red/Male',
      'Red/Female',
      'Red/Total',
      'No house/Male',
      'No house/Female',
      'No house/Total',
    ]);
    const gulistan = g.rows[0];
    expect(gulistan.counts['house:1~MALE']).toBe(1);
    expect(gulistan.counts['house:1~FEMALE']).toBe(1);
    expect(gulistan.counts['house:1~*']).toBe(2);
    expect(gulistan.counts['house:none~*']).toBe(1);
    // Leaf columns add up to the row total.
    const leaves = g.columns
      .filter((c) => !c.subtotal)
      .reduce((n, c) => n + (gulistan.counts[c.key] ?? 0), 0);
    expect(leaves).toBe(gulistan.total);
  });

  it('treats a split crossed with itself, or a second split alone, as one split', () => {
    expect(
      buildStrengthGrid(
        roll,
        { rows: 'campus', split: 'gender', split2: 'gender' },
        ctx,
      ).columns.map((c) => c.key),
    ).toEqual(['MALE', 'FEMALE']);
    expect(
      buildStrengthGrid(
        roll,
        { rows: 'campus', split: null, split2: 'gender' },
        ctx,
      ).columns,
    ).toEqual([]);
  });

  it('finds the students behind a cell', () => {
    const opts = {
      rows: 'section' as const,
      split: 'house' as const,
      split2: 'gender' as const,
    };
    const g = buildStrengthGrid(roll, opts, ctx);
    const classRow = g.rows.find(
      (r) =>
        r.level === 'class' && r.label === 'Class 3' && r.campus === 'Gulistan',
    )!;
    const hits = roll.filter((s) =>
      inCell(s, { row: classRow.key, column: 'house:1~FEMALE' }, opts, ctx),
    );
    expect(hits).toHaveLength(classRow.counts['house:1~FEMALE']);
    expect(
      roll.filter((s) => inCell(s, { row: classRow.key }, opts, ctx)),
    ).toHaveLength(classRow.total);
  });
});

const FE = { key: 'FEE_ENDOWMENT' as const, until: '2027-07-31' };

describe('special categories (TAFSD-452)', () => {
  it('splits by siblings: linked only with an Enrolled sibling', () => {
    expect(
      splitValue(student({ enrolled_siblings: 2 }), 'siblings', ctx).label,
    ).toBe('Has siblings');
    expect(splitValue(student(), 'siblings', ctx).label).toBe('No siblings');
  });

  it('names categories in full, never FE or Comp', () => {
    const label = (fe: boolean, comp: boolean) =>
      splitValue(
        student({
          benefits: [
            ...(fe ? [{ key: 'FEE_ENDOWMENT' as const, until: null }] : []),
            ...(comp ? [{ key: 'COMPLEMENTARY' as const, until: null }] : []),
          ],
        }),
        'category',
        ctx,
      ).label;
    expect(label(true, false)).toBe('Fee Endowment');
    expect(label(false, true)).toBe('Complementary');
    expect(label(true, true)).toBe('Fee Endowment and Complementary');
    expect(label(false, false)).toBe('Neither');
  });

  it('matches any value within a filter, and every filter together', () => {
    const fe = student({ benefits: [FE], enrolled_siblings: 1 });
    const single = student();
    expect(matchesCategoryFilters(fe, ['LINKED'], undefined)).toBe(true);
    expect(matchesCategoryFilters(single, ['LINKED'], undefined)).toBe(false);
    expect(matchesCategoryFilters(single, ['LINKED', 'SINGLE'], [])).toBe(true);
    expect(matchesCategoryFilters(fe, ['LINKED'], ['FEE_ENDOWMENT'])).toBe(
      true,
    );
    expect(matchesCategoryFilters(fe, ['SINGLE'], ['FEE_ENDOWMENT'])).toBe(
      false,
    );
    expect(matchesCategoryFilters(single, undefined, ['NONE'])).toBe(true);
    expect(
      matchesCategoryFilters(fe, undefined, ['NONE', 'COMPLEMENTARY']),
    ).toBe(false);
  });

  it('crosses siblings with the category for combinations', () => {
    const g = buildStrengthGrid(
      [
        student({ enrolled_siblings: 1, benefits: [FE] }),
        student({ enrolled_siblings: 1 }),
        student({ benefits: [FE] }),
      ],
      { rows: 'campus', split: 'siblings', split2: 'category' },
      ctx,
    );
    expect(g.totals.counts['sib:linked~cat:fee_endowment']).toBe(1);
    expect(g.totals.counts['sib:linked~cat:none']).toBe(1);
    expect(g.totals.counts['sib:single~cat:fee_endowment']).toBe(1);
    expect(g.totals.counts['sib:linked~*']).toBe(2);
  });
});

describe('more categories and ending soon (TAFSD-455)', () => {
  const ses = { key: 'SEHM_E_SADAAT' as const, until: '2027-03-31' };
  const mtf = { key: 'FEE_ENDOWMENT_MTF' as const, until: '2027-07-31' };

  it('labels the new categories and combinations in full', () => {
    expect(splitValue(student({ benefits: [ses] }), 'category', ctx).label).toBe(
      'Sehm-e-Sadaat',
    );
    expect(
      splitValue(student({ benefits: [mtf, ses] }), 'category', ctx).label,
    ).toBe('Fee Endowment (Monthly Tuition Fee) and Sehm-e-Sadaat');
  });

  it('orders single categories before combinations, Neither last', () => {
    const order = (b: (typeof FE)[]) =>
      splitValue(student({ benefits: b }), 'category', ctx).order as number;
    expect(order([FE])).toBeLessThan(order([ses]));
    expect(order([ses])).toBeLessThan(order([FE, ses]));
    expect(order([FE, ses])).toBeLessThan(order([]));
  });

  it('filters by a new category', () => {
    expect(matchesCategoryFilters(student({ benefits: [ses] }), undefined, ['SEHM_E_SADAAT'])).toBe(true);
    expect(matchesCategoryFilters(student({ benefits: [FE] }), undefined, ['SEHM_E_SADAAT'])).toBe(false);
  });

  it('keeps only benefits ending by the date, within the chosen categories', () => {
    const s = student({ benefits: [FE, ses] });
    expect(matchesCategoryFilters(s, undefined, undefined, '2027-04-01')).toBe(true);
    expect(matchesCategoryFilters(s, undefined, undefined, '2027-03-01')).toBe(false);
    expect(matchesCategoryFilters(s, undefined, ['FEE_ENDOWMENT'], '2027-04-01')).toBe(false);
    expect(
      matchesCategoryFilters(student({ benefits: [{ key: 'COMPLEMENTARY', until: null }] }), undefined, undefined, '2030-01-01'),
    ).toBe(false);
  });
});
