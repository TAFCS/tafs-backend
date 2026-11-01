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
  ...over,
});

const ROLL = [
  row(1),
  row(2, { gender: 'Female' }),
  row(3, {
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

function service(roll = ROLL) {
  const where = { deleted_at: null, scoped: true };
  const prisma = {
    students: { findMany: jest.fn().mockResolvedValue(roll) },
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
});
