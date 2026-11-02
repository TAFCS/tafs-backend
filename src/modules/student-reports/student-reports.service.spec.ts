import * as ExcelJS from 'exceljs';
import { StudentReportsService } from './student-reports.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

const row = (cc: number, over: Record<string, unknown> = {}) => ({
  cc,
  full_name: `Student ${cc}`,
  gr_number: String(cc),
  campus_id: 1,
  class_id: 5,
  section_id: 10,
  house_id: 1,
  gender: 'MALE',
  status: 'ENROLLED',
  dob: new Date('2018-03-15'),
  doa: new Date('2022-08-10'),
  campuses: { campus_name: 'Gulistan-e-Jauhar Campus' },
  classes: {
    description: 'Class 3',
    segment_id: 2,
    segments: { name: 'Junior', display_order: 2 },
  },
  sections: { description: 'A' },
  houses: { house_name: 'Red' },
  student_admissions: [],
  family_id: null,
  is_fee_endowment: false,
  fee_endowment_reason: null,
  fee_endowment_until: null,
  is_complementary: false,
  complementary_reason: null,
  complementary_until: null,
  ...over,
});

// TAFSD-452: 1 and 2 are Enrolled siblings; 3's only sibling (9) has left; 4 has no family.
const ROLL = [
  row(1, {
    family_id: 100,
    is_fee_endowment: true,
    fee_endowment_until: new Date('2027-06-30'),
  }),
  row(2, { gender: 'Female', family_id: 100 }),
  row(3, {
    family_id: 200,
    is_complementary: true,
    complementary_until: new Date('2026-01-01'),
    gender: 'female',
    section_id: 11,
    sections: { description: 'B' },
    house_id: 2,
    houses: { house_name: 'Blue' },
  }),
  row(4, {
    class_id: 6,
    classes: {
      description: 'Class 4',
      segment_id: 2,
      segments: { name: 'Junior', display_order: 2 },
    },
  }),
];

const LEFT_SIBLING = row(9, {
  family_id: 200,
  status: 'LEFT',
  full_name: 'Left Sibling',
});

function service(roll = ROLL) {
  const where = { deleted_at: null, scoped: true };
  const prisma = {
    students: {
      // The roll, or (TAFSD-452) the families' members across the school.
      findMany: jest.fn((args: { where: { family_id?: { in: number[] } } }) => {
        const fam = args.where.family_id?.in;
        if (!fam) return Promise.resolve(roll);
        return Promise.resolve(
          [...ROLL, LEFT_SIBLING].filter((r) =>
            fam.includes(r.family_id as number),
          ),
        );
      }),
    },
    campuses: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 1,
          campus_name: 'Gulistan-e-Jauhar Campus',
          campus_code: 'GEJ',
        },
      ]),
    },
    classes: { findMany: jest.fn().mockResolvedValue([]) },
    sections: { findMany: jest.fn().mockResolvedValue([]) },
    houses: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const students = { buildStudentsWhere: jest.fn().mockResolvedValue(where) };
  const svc = new StudentReportsService(prisma as any, students as any);
  return { svc, prisma, students, where };
}

const user = {
  sub: 'u1',
  username: 'aawaiz',
  fullName: 'Aawaiz Ali',
  role: 'SUPER_ADMIN',
} as unknown as IJwtStaffPayload;

describe('StudentReportsService', () => {
  it('picks students through the directory where-builder, so scope and filters match the directory', async () => {
    const { svc, prisma, students, where } = service();
    await svc.strength(
      { campus_id: [1], status: ['ENROLLED'], rows: 'class', split: 'gender' },
      user,
    );
    expect(students.buildStudentsWhere).toHaveBeenCalledWith(
      expect.objectContaining({ campus_id: [1], status: ['ENROLLED'] }),
      user,
    );
    expect(prisma.students.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
  });

  it('filters gender after folding the free text', async () => {
    const { svc } = service();
    const g = await svc.strength({ gender: ['FEMALE'], rows: 'campus' }, user);
    expect(g.totals.total).toBe(2);
  });

  it('lists the students behind a cell', async () => {
    const { svc } = service();
    const grid = await svc.strength({ rows: 'class', split: 'gender' }, user);
    const class3 = grid.rows.find((r) => r.label === 'Class 3')!;
    const cell = await svc.cellStudents(
      { rows: 'class', split: 'gender', row: class3.key, column: 'FEMALE' },
      user,
    );
    expect(cell.total).toBe(2);
    expect(cell.items.map((s) => s.cc)).toEqual([2, 3]);
  });

  it('writes one sheet per campus, class groups of section rows, and totals that match the screen', async () => {
    const { svc } = service();
    const file = await svc.exportStrength(
      { rows: 'section', split: 'house', split2: 'gender' },
      user,
    );
    expect(file.filename).toMatch(/^student-strength-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as any);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['GEJ']);
    const text: string[] = [];
    wb.worksheets[0].eachRow((r) =>
      text.push(
        (r.values as unknown[])
          .filter((v) => v != null && v !== '')
          .join(' | '),
      ),
    );
    const all = text.join('\n');
    expect(all).toContain('STUDENT STRENGTH REPORT');
    expect(all).toContain('BY HOUSE × GENDER');
    expect(all).toMatch(/CLASS 3/);
    expect(all).toMatch(/CLASS 4/);
    // Grand total row: 4 students.
    const totalRow = text.find(
      (t) =>
        /^TOTAL/.test(t) ||
        (/ TOTAL /.test(` ${t} `) && t.trim().endsWith('4')),
    );
    expect(totalRow).toBeDefined();
  });

  it('writes an empty sheet when nothing matches', async () => {
    const { svc } = service([]);
    const file = await svc.exportStrength({ rows: 'class' }, user);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as any);
    expect(wb.worksheets).toHaveLength(1);
  });

  describe('special categories (TAFSD-452)', () => {
    it('links students through an Enrolled sibling only', async () => {
      const { svc } = service();
      const g = await svc.strength({ rows: 'campus', split: 'siblings' }, user);
      expect(g.totals.counts['sib:linked']).toBe(2);
      expect(g.totals.counts['sib:single']).toBe(2);
    });

    it('filters by siblings and category', async () => {
      const { svc } = service();
      const single = await svc.strength(
        { rows: 'campus', siblings: ['SINGLE'] },
        user,
      );
      expect(single.totals.total).toBe(2);
      const fe = await svc.strength(
        { rows: 'campus', category: ['FEE_ENDOWMENT'] },
        user,
      );
      expect(fe.totals.total).toBe(1);
      // TAFSD-455: student 3's Complementary ended on 2026-01-01, so it doesn't count.
      const comp = await svc.strength(
        { rows: 'campus', category: ['COMPLEMENTARY'] },
        user,
      );
      expect(comp.totals.total).toBe(0);
    });

    it('names Enrolled siblings and the ones who left in the drill-down', async () => {
      const { svc } = service();
      const cell = await svc.cellStudents({ rows: 'class' }, user);
      const byCc = new Map(cell.items.map((s) => [s.cc, s]));
      expect(byCc.get(1)!.siblings.map((m) => m.cc)).toEqual([2]);
      expect(byCc.get(1)!.benefits).toEqual([
        expect.objectContaining({
          key: 'FEE_ENDOWMENT',
          until: '2027-06-30',
          active: true,
        }),
      ]);
      // TAFSD-455: an ended benefit is still listed, marked inactive.
      expect(byCc.get(3)!.benefits).toEqual([
        expect.objectContaining({ key: 'COMPLEMENTARY', active: false }),
      ]);
      expect(byCc.get(3)!.siblings).toEqual([]);
      expect(byCc.get(3)!.other_siblings.map((m) => m.status)).toEqual([
        'LEFT',
      ]);
    });

    it('prints reports A and B as PDF in the school sheet format (TAFSD-455)', async () => {
      const { svc } = service();
      for (const file of [
        await svc.exportStrength(
          { rows: 'class', split: 'gender', format: 'pdf' },
          user,
        ),
        await svc.exportCategories(
          {
            rows: 'class',
            split: 'siblings',
            split2: 'category',
            format: 'pdf',
          },
          user,
        ),
      ]) {
        expect(file.contentType).toBe('application/pdf');
        expect(file.filename).toMatch(/-A[34]\.pdf$/);
      }
    });

    it('exports the grid and a list sheet per campus, in full words', async () => {
      const { svc } = service();
      const file = await svc.exportCategories(
        { rows: 'class', split: 'siblings', split2: 'category' },
        user,
      );
      expect(file.filename).toMatch(/^special-categories-/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file.buffer as any);
      expect(wb.worksheets.map((w) => w.name)).toEqual(['GEJ', 'GEJ LIST']);
      const text: string[] = [];
      for (const ws of wb.worksheets)
        ws.eachRow((r) =>
          text.push(
            (r.values as unknown[])
              .filter((v) => v != null && v !== '')
              .join(' | '),
          ),
        );
      const all = text.join('\n');
      expect(all).toContain('SPECIAL CATEGORIES REPORT');
      expect(all).toContain('FEE ENDOWMENT');
      expect(all).toContain('FEE ENDOWMENT UNTIL 30-06-2027');
      expect(all).toContain('COMPLEMENTARY ENDED 01-01-2026');
      expect(all).toContain('LEFT SIBLING (LEFT)');
      expect(all).toContain('STUDENT 2 (CLASS 3 A)');
      expect(all).not.toMatch(/\bFE\b|\bCOMP\b/);
    });
  });
});
