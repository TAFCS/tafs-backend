import * as ExcelJS from 'exceljs';
import { MovementReportService } from './movement-report.service';
import { StudentReportsService } from './student-reports.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';

const CAMPUS = { campus_name: 'Gulistan-e-Jauhar Campus' };
const period = (over: Record<string, unknown>) => ({
  campus_id: 1,
  class_id: 3,
  campuses: CAMPUS,
  classes: { description: 'Class 3' },
  sections: { description: 'A' },
  ...over,
});

// 1: admitted this session, class recorded at admission. 2: admitted in 2018,
// class history only from 2026, so class not recorded. 3 left; 4 left and was
// reinstated (doesn't count).
const STUDENTS = [
  {
    cc: 1,
    full_name: 'New Student',
    gr_number: '100',
    status: 'ENROLLED',
    doa: new Date('2026-08-12T00:00:00Z'),
    campus_id: 1,
    campuses: CAMPUS,
    student_progression_periods: [
      period({ valid_from: new Date('2026-08-12T05:00:00Z') }),
    ],
  },
  {
    cc: 2,
    full_name: 'Old Student',
    gr_number: '200',
    status: 'ENROLLED',
    doa: new Date('2018-08-20T00:00:00Z'),
    campus_id: 1,
    campuses: CAMPUS,
    student_progression_periods: [
      period({ valid_from: new Date('2026-05-01T05:00:00Z'), class_id: 9 }),
    ],
  },
];
const LEFT = [
  period({
    student_cc: 3,
    change_type: 'LEFT',
    valid_from: new Date('2026-09-10T06:00:00Z'),
    valid_to: null,
    notes: 'Moved abroad',
    students: { full_name: 'Leaver', gr_number: '300', status: 'LEFT' },
  }),
  period({
    student_cc: 4,
    change_type: 'LEFT',
    valid_from: new Date('2026-09-11T06:00:00Z'),
    valid_to: new Date('2026-09-12T06:00:00Z'),
    notes: null,
    students: { full_name: 'Back Again', gr_number: '400', status: 'ENROLLED' },
  }),
];

function service() {
  const prisma = {
    students: {
      findMany: jest.fn(
        (args: {
          where: { AND: Array<{ doa?: { gte: Date; lte: Date } }> };
        }) => {
          const doa = args.where.AND[1].doa!;
          return Promise.resolve(
            STUDENTS.filter((s) => s.doa >= doa.gte && s.doa <= doa.lte),
          );
        },
      ),
    },
    student_progression_periods: {
      findMany: jest.fn((args: { where: { change_type: unknown } }) =>
        Promise.resolve(
          args.where.change_type === 'REINSTATED'
            ? [{ student_cc: 4, valid_from: new Date('2026-09-12T06:00:00Z') }]
            : LEFT,
        ),
      ),
      aggregate: jest.fn().mockResolvedValue({
        _min: { valid_from: new Date('2026-05-29T06:00:00Z') },
      }),
    },
    campuses: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { campus_name: 'Gulistan-e-Jauhar Campus', campus_code: 'GEJ' },
        ]),
    },
    classes: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const students = { buildStudentsWhere: jest.fn().mockResolvedValue({}) };
  const reports = new StudentReportsService(prisma as any, students as any);
  return new MovementReportService(prisma as any, students as any, reports);
}
const user = {
  sub: 'u',
  username: 'aawaiz',
  fullName: 'Aawaiz Ali',
} as unknown as IJwtStaffPayload;

describe('TAFSD-453: MovementReportService', () => {
  it('counts admissions in the class joined, and leavers not reinstated', async () => {
    const g = await service().movement(
      { from: '2026-08-01', to: '2026-10-31', period: 'session' },
      user,
    );
    expect(g.rows.map((r) => [r.level, r.label, r.total])).toEqual([
      ['campus', 'Gulistan-e-Jauhar Campus', 0],
      ['class', 'Class 3', 0],
    ]);
    expect(g.totals.counts).toEqual({
      '2026-2027~in': 1,
      '2026-2027~out': 1,
      '2026-2027~net': 0,
    });
    expect(g.notes).toEqual([]);
  });

  it('shows old admissions as class not recorded, and says when leaving dates start', async () => {
    const g = await service().movement(
      { from: '2018-08-01', to: '2026-10-31', period: 'session' },
      user,
    );
    expect(g.rows.map((r) => r.label)).toContain('Class not recorded');
    expect(g.notes).toHaveLength(2);
    expect(g.notes[1]).toContain('29-05-2026');
  });

  it('lists the students behind a cell', async () => {
    const r = await service().cellStudents(
      { from: '2026-08-01', to: '2026-10-31', column: '2026-09~out' },
      user,
    );
    expect(r.items.map((i) => [i.cc, i.type_label, i.note])).toEqual([
      [3, 'Left', 'Moved abroad'],
    ]);
  });

  it('rejects more than 36 months', async () => {
    await expect(
      service().movement({ from: '2020-01-01', to: '2026-10-31' }, user),
    ).rejects.toThrow(/most one report shows is 36/);
  });

  it('exports the counts and the list in the school format', async () => {
    const svc = service();
    for (const part of ['summary', 'list'] as const) {
      const file = await svc.export(
        { from: '2026-08-01', to: '2026-10-31', part },
        user,
      );
      expect(file.filename).toMatch(
        part === 'list'
          ? /^admissions-withdrawals-list-2026-08-01-to-2026-10-31/
          : /^admissions-withdrawals-2026-08-01-to-2026-10-31/,
      );
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file.buffer as any);
      const text: string[] = [];
      wb.worksheets[0].eachRow((r) =>
        text.push(
          (r.values as unknown[])
            .filter((v) => v != null && v !== '')
            .join(' | '),
        ),
      );
      const all = text.join('\n');
      expect(all).toContain('ADMISSIONS AND WITHDRAWALS REPORT');
      expect(all).toContain('FROM 1 AUGUST 2026 TO 31 OCTOBER 2026');
      expect(all).toContain('SESSION 2026–2027');
      if (part === 'list') {
        expect(all).toContain('MOVED ABROAD');
        expect(all).toContain('NEW STUDENT');
        expect(all).not.toContain('BACK AGAIN');
      } else {
        expect(all).toContain('AUG 2026');
        expect(all).toContain('NET');
      }
    }
  });

  it('names every session a long range covers in the heading', async () => {
    const file = await service().export(
      { from: '2018-08-01', to: '2026-10-31', period: 'session' },
      user,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as any);
    const text: string[] = [];
    wb.worksheets[0].eachRow((r) =>
      text.push(
        (r.values as unknown[])
          .filter((v) => v != null && v !== '')
          .join(' | '),
      ),
    );
    expect(text.join('\n')).toContain('SESSIONS 2018–2019 TO 2026–2027');
  });
});
