/**
 * TAFSD-602: the date of leaving is the last day worked, and is paid. Driven
 * through the real status endpoint, so the LEFT progression row opens at the
 * real click time, then read back through Attendance by Cycle (the matrix) and
 * a test payroll run.
 *
 * Covered: marked left on the leaving day itself keeps that day on roll and
 * paid; marked left and rejoined the same day by mistake changes nothing; a
 * past-dated leave that ends in a later rejoin still pays the old cycle exactly
 * through the leaving date once date_of_leaving has been cleared.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { computePayrollWindow, currentPayrollPeriodLabel, parsePayrollPeriod } from '../../src/modules/hr/payroll/payroll-period.util';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, USERS, seedSchool } from './helpers/fixtures';

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;

const DAY = 86_400_000;
const PAY = 31_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);
const midnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// The status change stamps the progression rows with the real clock, so the
// scenarios are anchored on today (UTC date, as the tenure windows read it).
const TODAY = midnight(new Date());
const current = parsePayrollPeriod(currentPayrollPeriodLabel());
const CUR = { ...computePayrollWindow(current.year, current.month), ...current };
const prevMonth = current.month === 1 ? 12 : current.month - 1;
const prevYear = current.month === 1 ? current.year - 1 : current.year;
const PREV = { ...computePayrollWindow(prevYear, prevMonth), year: prevYear, month: prevMonth };

const admin = () => client(app, tokenFor(jwt, USERS.admin));

async function seedEmployee(code: string): Promise<number> {
    const e = await prisma.employee_profiles.create({
        data: {
            employee_code: code,
            full_name: code,
            campus_id: CAMPUS_A,
            monthly_pay: new Prisma.Decimal(PAY),
            payroll_enabled: true,
            join_date: new Date('2024-01-01T00:00:00.000Z'),
        },
    });
    // Every employee in production carries an open ACTIVE row from onboarding.
    await prisma.employee_progression_periods.create({
        data: {
            employee_id: e.id,
            campus_id: CAMPUS_A,
            employment_status: 'ACTIVE',
            monthly_pay: new Prisma.Decimal(PAY),
            payroll_enabled: true,
            class_sections: [],
            change_type: 'ONBOARDED',
            valid_from: new Date('2024-01-01T00:00:00.000Z'),
        },
    });
    return e.id;
}

async function setStatus(id: number, body: Record<string, unknown>) {
    const res = await admin().patch(`/hr/employees/${id}/status`).send(body);
    expect(res.status).toBe(200);
}

async function tenureFor(id: number, window: { periodStart: Date; periodEnd: Date }) {
    const res = await admin()
        .get('/hr/payroll/attendance-matrix')
        .query({ campus_id: CAMPUS_A, period_start: ymd(window.periodStart), period_end: ymd(window.periodEnd), limit: 100 });
    expect(res.status).toBe(200);
    const line = res.body.data.lines.find((l: { employee_id: number }) => l.employee_id === id);
    expect(line).toBeDefined();
    return line.tenure as { windows: { start: string; end: string }[]; left_on: string | null; in_tenure_days: number };
}

async function testRunLine(id: number, cycle: { year: number; month: number }) {
    const res = await admin()
        .post('/hr/payroll/runs')
        .send({ campus_id: CAMPUS_A, year: cycle.year, month: cycle.month, employee_ids: [id] });
    expect(res.status).toBe(201);
    const line = await prisma.payroll_run_lines.findFirstOrThrow({
        where: { employee_id: id, payroll_runs: { is_test: true } },
        orderBy: { id: 'desc' },
    });
    const breakdownDates = (line.daily_breakdown as { date: string }[]).map((d) => d.date);
    return { line, breakdownDates };
}

/** Pay taken off for `offDays` days of a full cycle of `cycleDays`. */
const expectedOffRoll = (offDays: number, cycleDays: number) => (PAY / cycleDays) * offDays;

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    await seedSchool(prisma);
});

beforeEach(async () => {
    await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "payroll_run_lines", "payroll_runs", "employee_progression_periods", "employee_profiles" RESTART IDENTITY CASCADE',
    );
});

afterAll(async () => {
    await app?.close();
});

describe('TAFSD-602: marking an employee as left', () => {
    it('on the leaving day itself keeps that day on roll and paid', async () => {
        const id = await seedEmployee('T602-SAME');
        await setStatus(id, { status: 'LEFT', date_of_leaving: ymd(TODAY) });

        const tenure = await tenureFor(id, CUR);
        expect(tenure.windows[tenure.windows.length - 1].end).toBe(ymd(TODAY));
        expect(tenure.left_on).toBe(ymd(TODAY));

        const { line, breakdownDates } = await testRunLine(id, CUR);
        expect(breakdownDates).toContain(ymd(TODAY));
        expect(breakdownDates.filter((d) => d > ymd(TODAY))).toEqual([]);
        const cycleDays = daysBetween(CUR.periodStart, CUR.periodEnd) + 1;
        const offDays = daysBetween(TODAY, CUR.periodEnd);
        expect(Number(line.after_leaving_deduction)).toBeCloseTo(expectedOffRoll(offDays, cycleDays), 0);
    });

    it('then rejoined the same day by mistake leaves attendance and pay untouched', async () => {
        const id = await seedEmployee('T602-UNDO');
        await setStatus(id, { status: 'LEFT', date_of_leaving: ymd(TODAY) });
        await setStatus(id, { status: 'ACTIVE' });

        const tenure = await tenureFor(id, CUR);
        expect(tenure.windows).toEqual([{ start: ymd(CUR.periodStart), end: ymd(CUR.periodEnd) }]);
        expect(tenure.left_on).toBeNull();

        const { line } = await testRunLine(id, CUR);
        expect(Number(line.after_leaving_deduction)).toBe(0);
    });

    it('past-dated, then rejoined later: the old cycle still pays exactly through the leaving date', async () => {
        const id = await seedEmployee('T602-REJOIN');
        // Left on a day well inside the previous cycle, entered today (so the
        // LEFT row opens after the date), then brought back today with a new
        // joining date. The rejoin clears date_of_leaving.
        const leaving = addDays(PREV.periodStart, 10);
        await setStatus(id, { status: 'LEFT', date_of_leaving: ymd(leaving) });
        await setStatus(id, { status: 'ACTIVE', join_date: ymd(TODAY) });

        const profile = await prisma.employee_profiles.findUniqueOrThrow({ where: { id } });
        expect(profile.date_of_leaving).toBeNull();
        const rows = await prisma.employee_progression_periods.findMany({ where: { employee_id: id }, orderBy: { valid_from: 'asc' } });
        expect(rows.map((r) => r.employment_status)).toEqual(['ACTIVE', 'LEFT', 'ACTIVE']);
        // The leave's boundary sits on midnight UTC after the leaving date.
        expect(rows[0].valid_to).toEqual(addDays(leaving, 1));
        expect(rows[1].valid_from).toEqual(addDays(leaving, 1));

        const tenure = await tenureFor(id, PREV);
        expect(tenure.windows).toEqual([{ start: ymd(PREV.periodStart), end: ymd(leaving) }]);
        expect(tenure.left_on).toBe(ymd(leaving));

        const { line, breakdownDates } = await testRunLine(id, PREV);
        expect(breakdownDates).toContain(ymd(leaving));
        expect(breakdownDates.filter((d) => d > ymd(leaving))).toEqual([]);
        const cycleDays = daysBetween(PREV.periodStart, PREV.periodEnd) + 1;
        expect(Number(line.after_leaving_deduction)).toBeCloseTo(
            expectedOffRoll(daysBetween(leaving, PREV.periodEnd), cycleDays),
            0,
        );
    });
});
