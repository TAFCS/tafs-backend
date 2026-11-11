import { BadRequestException } from '@nestjs/common';
import { applyCategoryEdits, legacyCategoryEdits } from './student-category-edits';
import { flattenBenefits } from './student-benefits';
import { SEED_CATEGORIES } from '../../../test/student-categories.fixture';

/** An in-memory student_categories + student_category_assignments. */
function fakeTx(held: Array<{ category_id: number; reason?: string; until?: string; remind_from?: string }> = []) {
  const cats = [
    ...SEED_CATEGORIES,
    { id: 9, code: 'OLD_SCHEME', label: 'Old Scheme', description: null, tone: 'slate', display_order: 90, is_active: false },
  ];
  let nextId = 100;
  const rows = held.map((h) => ({
    id: nextId++,
    student_id: 7,
    category_id: h.category_id,
    reason: h.reason ?? null,
    until: h.until ? new Date(h.until) : null,
    remind_from: h.remind_from ? new Date(h.remind_from) : null,
  }));
  const tx = {
    student_categories: {
      findMany: jest.fn(async ({ where }: any) => cats.filter((c) => where.code.in.includes(c.code))),
    },
    student_category_assignments: {
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => r.student_id === where.student_id && where.category_id.in.includes(r.category_id)),
      ),
      create: jest.fn(async ({ data }: any) => {
        const r = { id: nextId++, reason: null, until: null, remind_from: null, ...data };
        rows.push(r);
        return r;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      }),
      delete: jest.fn(async ({ where }: any) => {
        rows.splice(rows.findIndex((x) => x.id === where.id), 1);
      }),
    },
  };
  return { tx: tx as any, rows };
}

describe('applyCategoryEdits (TAFSD-475)', () => {
  it('gives a category with its reason and dates, and logs it the way it did before', async () => {
    const { tx, rows } = fakeTx();
    const changes = await applyCategoryEdits(tx, 7, [
      { code: 'SEHM_E_SADAAT', on: true, reason: ' Syed family ', until: '2027-07-31', remind_from: '2027-06-20' },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ category_id: 4, reason: 'Syed family', until: new Date('2027-07-31') }),
    ]);
    expect(changes).toEqual([
      { field: 'student.is_sehm_e_sadaat', old_value: 'false', new_value: 'true' },
      { field: 'student.sehm_e_sadaat_reason', old_value: null, new_value: 'Syed family' },
      { field: 'student.sehm_e_sadaat_until', old_value: null, new_value: '2027-07-31' },
      { field: 'student.sehm_e_sadaat_remind_from', old_value: null, new_value: '2027-06-20' },
    ]);
  });

  it('needs a reason and an end date to give one, but not to re-save one held', async () => {
    const { tx } = fakeTx([{ category_id: 1, reason: 'Faculty', until: '2027-03-31' }]);
    await expect(
      applyCategoryEdits(tx, 7, [{ code: 'COMPLEMENTARY', on: true, reason: '', until: '2027-03-31' }]),
    ).rejects.toThrow('Complementary students require a reason and an until date');
    await expect(
      applyCategoryEdits(tx, 7, [{ code: 'FEE_ENDOWMENT', on: true, reason: '' }]),
    ).resolves.toEqual([]);
  });

  it('keeps the old reason when a re-save sends it blank, and moves the dates', async () => {
    const { tx, rows } = fakeTx([{ category_id: 1, reason: 'Faculty', until: '2027-03-31' }]);
    const changes = await applyCategoryEdits(tx, 7, [
      { code: 'FEE_ENDOWMENT', on: true, reason: '', until: '2027-07-31', remind_from: null },
    ]);
    expect(rows[0]).toEqual(expect.objectContaining({ reason: 'Faculty', until: new Date('2027-07-31') }));
    expect(changes).toEqual([
      { field: 'student.fee_endowment_until', old_value: '2027-03-31', new_value: '2027-07-31' },
    ]);
  });

  it('takes a category off and logs every detail it had', async () => {
    const { tx, rows } = fakeTx([{ category_id: 3, reason: 'Staff', until: '2027-03-31' }]);
    const changes = await applyCategoryEdits(tx, 7, [{ code: 'COMPLEMENTARY', on: false }]);
    expect(rows).toEqual([]);
    expect(changes.map((c) => c.field)).toEqual([
      'student.is_complementary',
      'student.complementary_reason',
      'student.complementary_until',
    ]);
  });

  it("refuses a retired category for a new student, and an unknown code", async () => {
    const { tx } = fakeTx();
    await expect(
      applyCategoryEdits(tx, 7, [{ code: 'OLD_SCHEME', on: true, reason: 'x', until: '2027-01-01' }]),
    ).rejects.toThrow('Old Scheme is retired');
    await expect(
      applyCategoryEdits(tx, 7, [{ code: 'NOPE', on: true, reason: 'x', until: '2027-01-01' }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a holder of a retired category keep editing it', async () => {
    const { tx, rows } = fakeTx([{ category_id: 9, reason: 'old', until: '2027-01-01' }]);
    await applyCategoryEdits(tx, 7, [{ code: 'OLD_SCHEME', on: true, reason: 'renewed' }]);
    expect(rows[0].reason).toBe('renewed');
  });

  it('ignores details for a category the student does not hold', async () => {
    const { tx, rows } = fakeTx();
    await applyCategoryEdits(tx, 7, [{ code: 'SEHM_E_IMAM', until: '2027-01-01' }]);
    expect(rows).toEqual([]);
  });
});

describe('legacyCategoryEdits (older webapp builds)', () => {
  it('turns the per-category fields into edits and names the keys to drop', () => {
    const { edits, keys } = legacyCategoryEdits({
      full_name: 'A',
      is_fee_endowment: true,
      fee_endowment_reason: 'Faculty',
      fee_endowment_until: '2027-03-31',
      is_complementary: false,
      complementary_reason: null,
    });
    expect(keys.sort()).toEqual(
      ['complementary_reason', 'fee_endowment_reason', 'fee_endowment_until', 'is_complementary', 'is_fee_endowment'].sort(),
    );
    expect(edits).toEqual([
      { code: 'FEE_ENDOWMENT', on: true, reason: 'Faculty', until: '2027-03-31', remind_from: undefined },
      { code: 'COMPLEMENTARY', on: false, reason: null, until: undefined, remind_from: undefined },
    ]);
  });
});

describe('flattenBenefits', () => {
  it('returns the categories plus the flat keys older screens read', () => {
    const out = flattenBenefits({
      student_category_assignments: [
        {
          reason: 'Staff',
          until: new Date('2027-07-31'),
          remind_from: null,
          student_categories: { code: 'STAFF_CHILD', label: 'Staff Child', display_order: 60 },
        },
      ],
    });
    expect(out).toEqual(
      expect.objectContaining({
        is_fee_endowment: false,
        is_complementary: false,
        is_staff_child: true,
        staff_child_reason: 'Staff',
        staff_child_until: '2027-07-31',
        categories: [
          { key: 'STAFF_CHILD', label: 'Staff Child', order: 60, reason: 'Staff', until: '2027-07-31', remind_from: null },
        ],
      }),
    );
  });
});
