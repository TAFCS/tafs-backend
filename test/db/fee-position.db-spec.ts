/**
 * TAFSD-620: Consolidated Fee Position Statement over HTTP — the real guards,
 * validation and Prisma queries, against the throwaway database.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import * as ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { bootApp, client, tokenFor } from './helpers/app';
import {
  CAMPUS_A,
  FEE,
  seedSchool,
  STUDENT,
  USERS,
  YEAR,
} from './helpers/fixtures';

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;

beforeAll(async () => {
  ({ app, prisma, jwt } = await bootApp());
});

afterAll(async () => {
  await app?.close();
});

const fee = (
  studentId: number,
  month: number,
  amount: number,
  over: Partial<Prisma.student_feesUncheckedCreateInput> = {},
) =>
  prisma.student_fees.create({
    data: {
      student_id: studentId,
      fee_type_id: FEE.MTF,
      academic_year: YEAR,
      target_month: month,
      month,
      fee_date: new Date(`2026-${String(month).padStart(2, '0')}-01`),
      amount: new Prisma.Decimal(amount),
      status: 'NOT_ISSUED',
      term_start_month: 8,
      ...over,
    },
  });

/** A deposit that put `amount` on one head, the way recordDeposit leaves it. */
const pay = async (feeId: number, amount: number, fromCredit = false) => {
  const f = await prisma.student_fees.findUniqueOrThrow({
    where: { id: feeId },
  });
  const deposit = await prisma.deposits.create({
    data: {
      student_id: f.student_id,
      total_amount: new Prisma.Decimal(amount),
      from_credit: fromCredit,
    },
  });
  await prisma.deposit_allocations.create({
    data: {
      deposit_id: deposit.id,
      student_fee_id: feeId,
      amount: new Prisma.Decimal(amount),
      type: 'FEE_HEAD',
    },
  });
  const paid = Number(f.amount_paid ?? 0) + amount;
  await prisma.student_fees.update({
    where: { id: feeId },
    data: {
      amount_paid: new Prisma.Decimal(paid),
      status: paid >= Number(f.amount) ? 'PAID' : 'PARTIALLY_PAID',
    },
  });
};

const csv = (text: string) =>
  text
    .replace(/^\ufeff/, '')
    .trim()
    .split('\n')
    .map((line) => line.split(','));

/**
 * One (A1): Aug 18,995 paid in cash; Sep 18,995 billed with a 2,000 discount, unpaid.
 * Two (A2): Aug 18,995, 10,000 paid from family credit, the rest waived.
 * April (A_APR): Sep 18,995 never billed, still enrolled.
 * Campus B (B1): has left; Sep 18,995 never billed.
 */
beforeAll(async () => {
  await seedSchool(prisma);
  const a1Aug = await fee(STUDENT.A1, 8, 18995, { status: 'ISSUED' });
  await pay(a1Aug.id, 18995);
  await fee(STUDENT.A1, 9, 18995, { status: 'ISSUED' });
  await fee(STUDENT.A1, 9, 2000, {
    is_discount: true,
    status: 'DISCOUNT',
    fee_type_id: null,
  });
  const a2Aug = await fee(STUDENT.A2, 8, 18995, { status: 'ISSUED' });
  await pay(a2Aug.id, 10000, true);
  await prisma.student_fees.update({
    where: { id: a2Aug.id },
    data: { status: 'WAIVED', waived_amount: new Prisma.Decimal(8995) },
  });
  await fee(STUDENT.A_APR, 9, 18995);
  await prisma.students.update({
    where: { cc: STUDENT.B1 },
    data: { status: 'LEFT' },
  });
  await fee(STUDENT.B1, 9, 18995);
});

const PATH =
  '/financial-reports/fee-position/export?from_date=2026-08-01&to_date=2026-09-30';

describe('Consolidated Fee Position export over HTTP (TAFSD-620)', () => {
  it('student detail as CSV: each row reconciles, and never-billed fees of a student who left are left out', async () => {
    const res = await client(app, tokenFor(jwt, USERS.admin)).get(
      `${PATH}&format=csv`,
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const [header, ...rows] = csv(res.text);
    const col = (name: string) => header.indexOf(name);
    const byCc = new Map(rows.map((r) => [Number(r[col('C.C.')]), r]));
    // The student who left has nothing but a never-billed head: not on the sheet.
    expect([...byCc.keys()].sort()).toEqual([
      STUDENT.A1,
      STUDENT.A2,
      STUDENT.A_APR,
    ]);

    const money = (cc: number, name: string) =>
      Number(byCc.get(cc)![col(name)]);
    for (const cc of byCc.keys()) {
      expect(
        money(cc, 'RECEIVABLES NET RECEIVABLE') -
          money(cc, 'RECOVERIES TOTAL RECOVERED'),
      ).toBe(money(cc, 'NET BALANCE'));
    }
    expect(money(STUDENT.A1, 'RECEIVABLES DISCOUNT')).toBe(-2000);
    expect(money(STUDENT.A1, 'BALANCE ON VOUCHERS')).toBe(16995);
    expect(money(STUDENT.A2, 'RECEIVABLES WAIVED')).toBe(-8995);
    expect(money(STUDENT.A2, 'RECOVERIES FROM FAMILY CREDIT')).toBe(10000);
    expect(money(STUDENT.A2, 'RECOVERIES CASH')).toBe(0);
    expect(money(STUDENT.A_APR, 'BALANCE NOT YET BILLED')).toBe(18995);
  });

  it('summary as Excel, and counting the never-billed fees when asked', async () => {
    const as = client(app, tokenFor(jwt, USERS.admin));
    const total = async (include: boolean) => {
      const res = await as
        .get(
          `${PATH}&format=xlsx&layout=summary${include ? '&include_unbilled_after_leaving=true' : ''}`,
        )
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as Buffer);
      const ws = wb.worksheets[0];
      const texts: string[] = [];
      ws.eachRow((r) => texts.push(String(r.getCell(1).value ?? '')));
      const last = ws.getRow(ws.rowCount).values as unknown[];
      return { tab: ws.name, texts, netBalance: Number(last[last.length - 1]) };
    };
    const without = await total(false);
    // Only campus A has anything to count, so there is no ALL CAMPUSES sheet.
    expect(without.tab).toBe('TA');
    expect(without.texts).toContain('CONSOLIDATED FEE POSITION STATEMENT');
    expect(without.texts).toContain(
      'NOT COUNTED: 18,995 NEVER BILLED TO STUDENTS WHO HAVE LEFT, GRADUATED OR BEEN EXPELLED',
    );
    // 16,995 owed by One + 18,995 never billed to April.
    expect(without.netBalance).toBe(35990);

    const withLeft = await total(true);
    expect(withLeft.tab).toBe('ALL CAMPUSES');
    expect(withLeft.netBalance).toBe(35990 + 18995);
    expect(withLeft.texts.some((t) => t.startsWith('NOT COUNTED'))).toBe(false);
  });

  it('follows the page filters', async () => {
    const res = await client(app, tokenFor(jwt, USERS.admin)).get(
      `${PATH}&format=csv&campus_id=${CAMPUS_A}&student_status=ENROLLED&layout=monthly`,
    );
    expect(res.status).toBe(200);
    const [header, ...rows] = csv(res.text);
    expect(header).toContain('RECEIVABLES AUG');
    expect(header).toContain('BALANCE SEP');
    expect(rows).toHaveLength(3);
  });

  it('refuses a user without the Financial Reports grants, and a bad layout', async () => {
    expect(
      (await client(app, tokenFor(jwt, USERS.viewer)).get(`${PATH}&format=csv`))
        .status,
    ).toBe(403);
    expect(
      (
        await client(app, tokenFor(jwt, USERS.admin)).get(
          `${PATH}&format=csv&layout=weekly`,
        )
      ).status,
    ).toBe(400);
  });
});
