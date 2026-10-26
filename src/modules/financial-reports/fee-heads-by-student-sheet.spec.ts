import * as ExcelJS from 'exceljs';
import { fee_status_enum } from '@prisma/client';
import { FinancialReportsService } from './financial-reports.service';

// TAFSD-341: Fee Heads "By student" Excel in the defaulters student-sheet format.

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const g = (student_id: number, fee_date: string, fee_type_id: number | null, is_discount: boolean, status: fee_status_enum, amount: number, amount_paid: number) => ({
  student_id, fee_date: d(fee_date), fee_type_id, is_discount, status,
  _sum: { amount, amount_paid }, _count: { _all: 1 },
});

function service(extra: ReturnType<typeof g>[] = []) {
  const prisma = {
    students: {
      findMany: jest.fn(async () => [
        { cc: 101, gr_number: '5529', full_name: 'Ali', status: 'ENROLLED', class_id: 16, graduated_from_class_id: null,
          campuses: { campus_name: 'Gulistan-e-Johar Campus', campus_code: 'GEJ' }, classes: { description: 'VII' }, graduated_from_class: null, sections: { description: 'A' } },
        { cc: 102, gr_number: '5530', full_name: 'Sara', status: 'ENROLLED', class_id: 15, graduated_from_class_id: null,
          campuses: { campus_name: 'Gulistan-e-Johar Campus', campus_code: 'GEJ' }, classes: { description: 'VI' }, graduated_from_class: null, sections: { description: 'B' } },
      ]),
    },
    student_fees: {
      groupBy: jest.fn(async () => [
        // Ali: Aug tuition 10,000 + lab 2,000 with a 1,000 discount, paid 8,000 of it in cash
        // (the discount consumed 1,000 more); Sep tuition 10,000 unpaid.
        g(101, '2026-08-01', 1, false, fee_status_enum.PARTIALLY_PAID, 10000, 9000),
        g(101, '2026-08-01', 2, false, fee_status_enum.ISSUED, 2000, 0),
        g(101, '2026-08-01', null, true, fee_status_enum.DISCOUNT, 1000, 1000), // stored positive
        g(101, '2026-09-01', 1, false, fee_status_enum.ISSUED, 10000, 0),
        // Sara: Aug tuition paid in full; Sep tuition 5,000 waived.
        g(102, '2026-08-01', 1, false, fee_status_enum.PAID, 10000, 10000),
        g(102, '2026-09-01', 1, false, fee_status_enum.WAIVED, 5000, 0),
        ...extra,
      ]),
    },
    fee_types: {
      findMany: jest.fn(async () => [
        { id: 1, description: 'Tuition', priority_order: 1 },
        { id: 2, description: 'Lab', priority_order: 2 },
      ]),
    },
  };
  const s = new FinancialReportsService(prisma as any, {} as any, { whereForStudents: () => ({}) } as any) as any;
  s.loadSiblingGrNumbers = jest.fn(async () => new Map());
  s.loadDefaulterContacts = jest.fn(async () => new Map());
  s.loadDefaulterFamilies = jest.fn(async () => new Map());
  s.loadDefaulterFilterNames = jest.fn(async () => ({ campuses: new Map(), classes: new Map(), sections: new Map(), segments: new Map() }));
  s.staffLabel = jest.fn(async () => 'AAWAIZ ALI (aawaiz.ali)');
  return s;
}

const user = { sub: 1, username: 'aawaiz.ali', role: 'SUPER_ADMIN', permissions: [] };

async function load(query: Record<string, unknown>, extra: ReturnType<typeof g>[] = []) {
  const file = await service(extra).exportFeeHeads({ from_date: '2026-08-01', to_date: '2026-09-30', view: 'student', format: 'xlsx', ...query }, user);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer as any);
  const ws = wb.worksheets[0];
  let hdr = 1;
  while (ws.getCell(hdr, 1).value !== 'S#') hdr++;
  const row = (r: number) => (ws.getRow(r).values as unknown[]).slice(1);
  return { file, ws, hdr, row };
}

describe('Fee Heads by student export, defaulters format (TAFSD-341)', () => {
  it('one row per student in class order, month columns of net billed, and money that reconciles', async () => {
    const { file, ws, hdr, row } = await load({});
    expect(file.filename).toBe('fee-heads-by-student-2026-08-01-to-2026-09-30.xlsx');
    expect(ws.name).toBe('GEJ');
    const header = row(hdr);
    expect(header).toEqual(expect.arrayContaining(['AUG', 'SEP', 'AMOUNT', 'PAID', 'WAIVED', 'OUTSTANDING', 'REMARKS']));
    const at = (h: string) => header.indexOf(h);
    const sara = row(hdr + 1); // class VI before VII
    const ali = row(hdr + 2);
    expect(sara[at('STUDENT NAME')]).toBe('SARA');
    expect([sara[at('AUG')], sara[at('SEP')], sara[at('AMOUNT')], sara[at('PAID')], sara[at('WAIVED')], sara[at('OUTSTANDING')], sara[at('REMARKS')]])
      .toEqual([10000, 5000, 15000, 10000, 5000, 0, 'Paid']);
    // Ali: Aug net 11,000 (12,000 less the 1,000 discount); paid is cash only, 8,000.
    expect([ali[at('AUG')], ali[at('SEP')], ali[at('AMOUNT')], ali[at('PAID')], ali[at('WAIVED')], ali[at('OUTSTANDING')], ali[at('REMARKS')]])
      .toEqual([11000, 10000, 21000, 8000, 0, 13000, 'Part-paid']);
    const total = row(hdr + 3);
    expect([total[at('AMOUNT')], total[at('PAID')], total[at('WAIVED')], total[at('OUTSTANDING')]]).toEqual([36000, 18000, 5000, 13000]);
  });

  it('with breakdown_by_head: fee heads under each month, discount as its own column', async () => {
    const { hdr, row } = await load({ breakdown_by_head: true });
    const months = row(hdr);
    const heads = row(hdr + 1);
    const aug = months.indexOf('AUG');
    expect(heads.slice(aug, aug + 4)).toEqual(['TUITION', 'LAB', 'DISCOUNT', 'TOTAL']);
    const ali = row(hdr + 3);
    expect(ali.slice(aug, aug + 4)).toEqual([10000, 2000, -1000, 11000]);
  });

  it('CSV carries the same columns, and the PDF keeps the flat school table', async () => {
    const s = service();
    const csv = await s.exportFeeHeads({ from_date: '2026-08-01', to_date: '2026-09-30', view: 'student', format: 'csv' }, user);
    const [header, first] = csv.buffer.toString('utf8').replace('﻿', '').split('\n');
    expect(header).toBe('Campus,S#,C.C.,G.R.#,Link to GR,Level,Student Name,Status,Contact,AUG,SEP,Amount,Amount paid,Waived,Outstanding,Remarks');
    expect(first).toContain('Sara');
    expect(s.prisma.student_fees.groupBy).toHaveBeenCalledWith(expect.objectContaining({ by: ['student_id', 'fee_date', 'fee_type_id', 'is_discount', 'status'] }));
  });

  describe('split_by_fee_date (TAFSD-431)', () => {
    // Ali also billed 3,000 on 2 Aug: August has two fee dates, September one.
    const secondDate = [g(101, '2026-08-02', 2, false, fee_status_enum.ISSUED, 3000, 0)];

    it('off by default: one column per month, the two August dates added together', async () => {
      const { hdr, row } = await load({}, secondDate);
      const header = row(hdr);
      const ali = row(hdr + 2);
      expect(ali[header.indexOf('AUG')]).toBe(14000);
    });

    it('on: a column per date in a month with several, the month TOTAL after; one date is a sub-header', async () => {
      const { ws, hdr, row } = await load({ split_by_fee_date: true }, secondDate);
      const months = row(hdr);
      const dates = row(hdr + 1);
      const aug = months.indexOf('AUG');
      expect(dates.slice(aug, aug + 4)).toEqual(['1 AUG', '2 AUG', 'TOTAL', '1 SEP']);
      expect(ws.getCell(hdr, aug + 2).isMerged).toBe(true); // AUG spans its three sub-columns
      expect(months[aug + 3]).toBe('SEP');
      const sara = row(hdr + 2);
      const ali = row(hdr + 3);
      expect(ali.slice(aug, aug + 4)).toEqual([11000, 3000, 14000, 10000]);
      expect(sara.slice(aug, aug + 4)).toEqual([10000, undefined, 10000, 5000]);
      expect(ali[months.indexOf('AMOUNT')]).toBe(24000);
    });

    it('on with the head breakdown: heads stay, the dates go in REMARKS', async () => {
      const { hdr, row } = await load({ split_by_fee_date: true, breakdown_by_head: true }, secondDate);
      const heads = row(hdr + 1);
      expect(heads).not.toContain('1 AUG');
      const ali = row(hdr + 3);
      expect(ali[row(hdr).indexOf('REMARKS')]).toBe('Part-paid\nAUG: 1 AUG 11,000 · 2 AUG 3,000');
    });

    it('CSV: the date columns and the month TOTAL', async () => {
      const csv = await service(secondDate).exportFeeHeads(
        { from_date: '2026-08-01', to_date: '2026-09-30', view: 'student', format: 'csv', split_by_fee_date: true },
        user,
      );
      const [header] = csv.buffer.toString('utf8').replace('\ufeff', '').split('\n');
      expect(header).toContain('1 AUG,2 AUG,AUG TOTAL,1 SEP,Amount');
    });
  });
});
