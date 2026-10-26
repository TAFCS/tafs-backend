import * as ExcelJS from 'exceljs';
import { FinancialReportsService } from './financial-reports.service';

// TAFSD-341: pins the defaulters student sheet, cell by cell, before its writer
// is shared with the fee date report. Any change to these snapshots is a change
// to the defaulters export itself and must be deliberate.

const JUL = 2026 * 12 + 6;
const AUG = 2026 * 12 + 7;
const SEP = 2026 * 12 + 8;

function build() {
  const service = new FinancialReportsService({} as any, {} as any, {} as any);
  const months = new Map([
    [
      101,
      new Map([
        [JUL - 6, { owed: 5000, partial: false, heads: [{ name: 'Tuition', owed: 5000, partial: false }] }],
        [AUG, { owed: 12000, partial: false, heads: [{ name: 'Tuition', owed: 9000, partial: false }, { name: 'Lab', owed: 3000, partial: false }] }],
        [SEP, { owed: 4000, partial: true, heads: [{ name: 'Tuition', owed: 4000, partial: true }] }],
      ]),
    ],
    [102, new Map([[SEP, { owed: 9000, partial: false, heads: [{ name: 'Tuition', owed: 9000, partial: false }] }]])],
    [
      103,
      new Map([
        [AUG, { owed: 7000, partial: false, heads: [{ name: 'Tuition', owed: 7000, partial: false }] }],
        // TAFSD-418: November tuition billed in advance and left unpaid -> LATER.
        [SEP + 2, { owed: 7000, partial: false, heads: [{ name: 'Tuition', owed: 7000, partial: false }] }],
      ]),
    ],
    [201, new Map([[JUL, { owed: 6000, partial: true, heads: [{ name: 'Tuition', owed: 6000, partial: true }] }]])],
  ]);
  const s = service as any;
  s.loadDefaulterOwedMonths = jest.fn(async () => months);
  s.loadSiblingGrNumbers = jest.fn(async () => new Map([[101, ['5530']], [102, ['5529']]]));
  s.loadDefaulterContacts = jest.fn(async () => new Map([[101, ['FATHER 0312-2244523', 'MOTHER 0300-1234567']], [201, ['FATHER 0333-1112223']]]));
  s.loadDefaulterFamilies = jest.fn(async () => new Map([[101, { id: 9, household_name: 'Khan' }], [102, { id: 9, household_name: 'Khan' }]]));
  s.loadDefaulterFilterNames = jest.fn(async () => ({ campuses: [], classes: [], sections: [], segments: [] }));
  s.formatPktDateTime = jest.fn(() => '22 OCT 2026, 10:00 PM');
  s.staffLabel = jest.fn(async () => 'AAWAIZ.ALI');
  const items = [
    { cc: 101, gr_number: '5529', student_name: 'Ali Khan', campus: 'Gulistan-e-Johar Campus', campus_code: 'GEJ', class_id: 16, class_name: 'VII', section: 'A', student_status: 'ENROLLED', category: 'DEFAULTER' },
    { cc: 102, gr_number: '5530', student_name: 'Sara Khan', campus: 'Gulistan-e-Johar Campus', campus_code: 'GEJ', class_id: 16, class_name: 'VII', section: 'B', student_status: 'ENROLLED', category: 'EXPIRING' },
    { cc: 103, gr_number: 'A-101', student_name: 'Omar', campus: 'Gulistan-e-Johar Campus', campus_code: 'GEJ', class_id: 17, class_name: 'VIII', section: 'A', student_status: 'LEFT', category: 'DEFAULTER' },
    { cc: 201, gr_number: 'KF-A12', student_name: 'Hina', campus: 'Kaneez Fatima Campus', campus_code: 'KF', class_id: 3, class_name: 'II', section: 'A', student_status: 'ENROLLED', category: 'DEFAULTER' },
  ];
  return (query: Record<string, unknown>) =>
    s.buildDefaultersStudentReport(items, '2026-10-16', { strip_months: 3, ...query }, 'golden', { sub: 1, username: 'aawaiz.ali' });
}

/** Every sheet as rows of `value|numFmt`, plus merges, heights and widths. */
async function dump(file: { buffer: Buffer }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer as any);
  return wb.worksheets.map((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, r) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const font = cell.font ? `${cell.font.size ?? ''}${cell.font.bold ? 'b' : ''}` : '';
        cells.push(`${JSON.stringify(cell.value ?? null)}|${cell.numFmt ?? ''}|${font}`);
      });
      rows[r - 1] = [`h=${row.height ?? ''}`, ...cells];
    });
    const widths = (ws.columns ?? []).map((c) => c.width ?? null);
    return {
      name: ws.name,
      rows,
      merges: (ws.model as any).merges ?? [],
      widths,
      views: ws.views,
      pageSetup: { ...ws.pageSetup },
    };
  });
}

describe('defaulters student sheet golden output (TAFSD-341)', () => {
  const variants: Array<[string, Record<string, unknown>]> = [
    ['plain', {}],
    ['breakdown', { breakdown_by_head: true }],
    ['group by class', { group_by: 'class' }],
    ['group by section', { group_by: 'section', breakdown_by_head: true }],
    ['group by family', { group_by: 'family' }],
    ['column subset', { columns: ['sno', 'cc', 'name', 'months', 'remarks'] }],
    ['no amount column', { columns: ['sno', 'name', 'months'], breakdown_by_head: true }],
    ['long window', { months_back: 15 }],
    ['months filter line', { min_months_behind: 4, max_months_behind: 5 }],
  ];
  for (const [label, query] of variants) {
    it(`xlsx: ${label}`, async () => {
      expect(await dump(await build()({ format: 'xlsx', ...query }))).toMatchSnapshot();
    });
  }

  it('xlsx: nothing matched', async () => {
    const service = new FinancialReportsService({} as any, {} as any, {} as any) as any;
    service.loadDefaulterOwedMonths = jest.fn(async () => new Map());
    service.loadSiblingGrNumbers = jest.fn(async () => new Map());
    service.loadDefaulterContacts = jest.fn(async () => new Map());
    service.loadDefaulterFilterNames = jest.fn(async () => ({ campuses: [], classes: [], sections: [], segments: [] }));
    service.formatPktDateTime = jest.fn(() => '22 OCT 2026, 10:00 PM');
    const file = await service.buildDefaultersStudentReport([], '2026-10-16', { format: 'xlsx' }, 'golden');
    expect(await dump(file)).toMatchSnapshot();
  });

  for (const [label, query] of [
    ['plain', {}],
    ['breakdown + family groups', { breakdown_by_head: true, group_by: 'family' }],
    ['column subset', { columns: ['cc', 'name', 'contact', 'months'] }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`csv: ${label}`, async () => {
      const file = await build()({ format: 'csv', ...query });
      expect(file.filename).toBe('golden.csv');
      expect(file.buffer.toString('utf8')).toMatchSnapshot();
    });
  }
});
