/**
 * TAFSD-589: "Mark collected" for a loan or security deposit (NPD) installment
 * taken outside payroll, through the real guards into a real Postgres.
 *
 * Covered: the action is default-deny (an old `hr.employees.edit` holder with
 * the tile does not get it; only an explicit tick does); marking takes the
 * plan's next due cycle and uses up its slot; a partial amount carries the
 * shortfall; a bulk call for a cycle refuses anyone whose next cycle is a
 * different one, so a repeat charges nobody twice; payroll for a cycle already
 * marked deducts nothing and leaves the schedule alone, while the next cycle's
 * payroll takes the next slot; Undo puts the slot back, and is refused once a
 * payroll for that cycle or later is finalized.
 */
import type { INestApplication } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { Prisma, StaffRole } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../../src/modules/access/access.service';
import { EmployeeLoansService } from '../../src/modules/hr/employee-loans/employee-loans.service';
import { computePayrollWindow, currentPayrollPeriodLabel, parsePayrollPeriod } from '../../src/modules/hr/payroll/payroll-period.util';
import { SecurityDepositsService } from '../../src/modules/hr/security-deposits/security-deposits.service';
import { bootApp, client, tokenFor } from './helpers/app';
import { CAMPUS_A, USERS, seedSchool, type SeededUser } from './helpers/fixtures';

const HR: SeededUser = { id: 'db-suite-hr-589', username: 'dbsuite.hr589', role: StaffRole.FINANCE_CLERK };
const NPD_TILE = 'hr.security_deposits';
const LOAN_TILE = 'hr.employee_loans';

let app: INestApplication;
let prisma: PrismaService;
let jwt: JwtService;
let deposits: SecurityDepositsService;
let loans: EmployeeLoansService;

const day = (d: Date) => d.toISOString().slice(0, 10);
const shift = (d: Date, months: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 26));
const { year, month } = parsePayrollPeriod(currentPayrollPeriodLabel());
const CURRENT = computePayrollWindow(year, month).periodStart;
/** The plans start two cycles back, so two cycles are markable today. */
const C1 = shift(CURRENT, -2);
const C2 = shift(CURRENT, -1);

const EMP = { npd: 0, loan: 0, both: 0 };

async function employee(code: string): Promise<number> {
    const e = await prisma.employee_profiles.create({
        data: { employee_code: code, full_name: code, campus_id: CAMPUS_A, monthly_pay: new Prisma.Decimal(50000), payroll_enabled: true },
    });
    return e.id;
}

async function payrollLine(employeeId: number, periodStart: Date, extra: Partial<Prisma.payroll_run_linesUncheckedCreateInput> = {}) {
    const end = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 25));
    const run = await prisma.payroll_runs.upsert({
        where: {
            campus_id_period_start_period_end_is_test_kind: { campus_id: CAMPUS_A, period_start: periodStart, period_end: end, is_test: false, kind: 'REGULAR' },
        },
        update: {},
        create: { campus_id: CAMPUS_A, period_start: periodStart, period_end: end },
    });
    const zero = new Prisma.Decimal(0);
    return prisma.payroll_run_lines.create({
        data: {
            payroll_run_id: run.id,
            employee_id: employeeId,
            scheduled_working_days: 26,
            present_days: 26,
            late_days: 0,
            half_days: 0,
            absent_days: 0,
            excused_days: 0,
            monthly_pay: new Prisma.Decimal(50000),
            daily_rate: zero,
            per_minute_rate: zero,
            absence_deduction: zero,
            half_day_deduction: zero,
            break_deduction: zero,
            total_deductions: zero,
            net_pay: new Prisma.Decimal(50000),
            ...extra,
        },
    });
}

const plan = (employeeId: number) => prisma.employee_security_deposits.findFirstOrThrow({ where: { employee_id: employeeId } });
const loanOf = (employeeId: number) => prisma.employee_loans.findFirstOrThrow({ where: { employee_id: employeeId } });

beforeAll(async () => {
    ({ app, prisma, jwt } = await bootApp());
    deposits = app.get(SecurityDepositsService);
    loans = app.get(EmployeeLoansService);
    await seedSchool(prisma);
    await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "employee_security_deposit_transactions", "employee_security_deposits", "employee_loan_transactions", "employee_loans", "payroll_run_lines", "payroll_runs", "employee_profiles" RESTART IDENTITY CASCADE',
    );

    await prisma.users.create({ data: { id: HR.id, username: HR.username, full_name: HR.username, role: HR.role, password_hash: 'x', is_active: true } });
    for (const key of ['hr.employees.view', 'hr.employees.edit']) {
        const p = await prisma.permissions.upsert({ where: { key }, update: {}, create: { key, module: 'hr', description: key } });
        await prisma.user_permissions.create({ data: { user_id: HR.id, permission_id: p.id, granted: true, granted_by: USERS.admin.id } });
    }
    for (const tile of [NPD_TILE, LOAN_TILE]) {
        await prisma.user_tile_grants.create({ data: { user_id: HR.id, tile_id: tile, allow: true, granted_by: USERS.admin.id } });
    }
    await prisma.user_scope_entries.create({ data: { user_id: HR.id, dimension: 'CAMPUS', ref_id: CAMPUS_A } });

    EMP.npd = await employee('T589-NPD');
    EMP.loan = await employee('T589-LOAN');
    EMP.both = await employee('T589-BOTH');

    for (const id of [EMP.npd, EMP.both]) {
        await prisma.employee_security_deposits.create({
            data: {
                employee_id: id,
                total_amount: 30000,
                installment_count: 3,
                installment_amount: 10000,
                installment_schedule: [10000, 10000, 10000],
                start_period_start: C1,
                created_by: 'db-suite',
            },
        });
    }
    for (const id of [EMP.loan, EMP.both]) {
        await prisma.employee_loans.create({
            data: {
                employee_id: id,
                total_amount: 9000,
                installment_count: 3,
                installment_amount: 3000,
                installment_schedule: [3000, 3000, 3000],
                disbursement_date: C1,
                start_period_start: C1,
                created_by: 'db-suite',
            },
        });
    }
});

afterAll(async () => {
    await app?.close();
});

describe('Mark collected outside payroll', () => {
    const hr = () => client(app, tokenFor(jwt, HR));

    it('is default-deny: the old hr.employees.edit bridge does not confer it', async () => {
        const npd = await hr().post(`/hr/employees/${EMP.npd}/security-deposit/mark-collected`).send({ notes: 'x' });
        expect(npd.status).toBe(403);
        const loan = await hr().post(`/hr/employees/${EMP.loan}/loan/mark-collected`).send({ notes: 'x' });
        expect(loan.status).toBe(403);
        const bulk = await hr().post('/hr/security-deposits/mark-collected').send({ period_start: day(C1), notes: 'x', items: [{ employee_id: EMP.npd }] });
        expect(bulk.status).toBe(403);

        // The same holder still has every older action (refund, etc.) through the bridge.
        const view = await hr().get(`/hr/employees/${EMP.npd}/security-deposit`);
        expect(view.status).toBe(200);

        for (const tile of [NPD_TILE, LOAN_TILE]) {
            await prisma.user_tile_action_grants.create({
                data: { user_id: HR.id, tile_id: tile, action_id: 'mark_collected', allow: true, granted_by: USERS.admin.id },
            });
        }
        // A raw grant bypasses AccessService, so drop the cached session as its own grant API would.
        app.get(AccessService).invalidateLiveSession(HR.id);
    });

    it('marks the next due NPD cycle, partially, and carries the shortfall', async () => {
        const res = await hr()
            .post(`/hr/employees/${EMP.npd}/security-deposit/mark-collected`)
            .send({ period_start: day(C1), amount: 6000, notes: 'Cash' });
        expect(res.status).toBe(201);
        const current = res.body.data.current;
        expect(current.recovered_amount).toBe(6000);
        expect(current.carried_forward_amount).toBe(4000);
        expect(current.next_collection_period_start).toBe(day(C2));
        expect(current.next_due_amount).toBe(14000);
        const txn = current.transactions.at(-1);
        expect(txn).toMatchObject({ amount: 6000, due_amount: 10000, period_start: day(C1), recorded_manually: true, can_undo: true });

        const audit = await prisma.audit_logs.findFirst({ where: { action: 'SECURITY_DEPOSIT_MARKED_COLLECTED', entity_id: String(EMP.npd) } });
        expect(audit?.note).toContain('4000.00 carries to the next cycle');
    });

    it('refuses a cycle that is not the next one due, and a cycle that has not started', async () => {
        const wrong = await hr().post(`/hr/employees/${EMP.npd}/security-deposit/mark-collected`).send({ period_start: day(C1), notes: 'again' });
        expect(wrong.status).toBe(409);
        const tooMuch = await hr().post(`/hr/employees/${EMP.loan}/loan/mark-collected`).send({ amount: 3001, notes: 'x' });
        expect(tooMuch.status).toBe(400);
    });

    it('bulk marks one cycle and refuses, per employee, anyone already past it', async () => {
        const res = await hr()
            .post('/hr/employee-loans/mark-collected')
            .send({ period_start: day(C1), notes: 'Paper payroll', items: [{ employee_id: EMP.loan }, { employee_id: EMP.both }] });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ marked: 2, failed: 0, total_amount: 6000 });

        const again = await hr()
            .post('/hr/employee-loans/mark-collected')
            .send({ period_start: day(C1), notes: 'Paper payroll', items: [{ employee_id: EMP.loan }] });
        expect(again.body.data).toMatchObject({ marked: 0, failed: 1 });
        expect(again.body.data.results[0].error).toContain('next installment due is for');
        expect(Number((await loanOf(EMP.loan)).recovered_amount)).toBe(3000);
    });

    it('payroll for a cycle already marked deducts nothing and leaves the slot alone', async () => {
        const before = await plan(EMP.both);
        // EMP.both's NPD for C1 is marked by hand; its loan C1 was marked in bulk above.
        await hr().post(`/hr/employees/${EMP.both}/security-deposit/mark-collected`).send({ period_start: day(C1), notes: 'Cash' });
        const marked = await plan(EMP.both);
        expect(Number(marked.recovered_amount)).toBe(Number(before.recovered_amount) + 10000);

        const line = await payrollLine(EMP.both, C1);
        await loans.applySnapshotToLine(line.payroll_run_id, EMP.both);
        await deposits.applySnapshotToLine(line.payroll_run_id, EMP.both);
        const snap = await prisma.payroll_run_lines.findUniqueOrThrow({ where: { id: line.id } });
        expect(Number(snap.loan_deduction)).toBe(0);
        expect(Number(snap.security_deposit_deduction)).toBe(0);

        await prisma.payroll_run_lines.update({ where: { id: line.id }, data: { finalized_at: new Date() } });
        await loans.commitLineDeduction(line.id, 'db-suite');
        await deposits.commitLineDeduction(line.id, 'db-suite');
        expect(await prisma.employee_security_deposit_transactions.count({ where: { payroll_run_line_id: line.id } })).toBe(0);
        expect(await prisma.employee_loan_transactions.count({ where: { payroll_run_line_id: line.id } })).toBe(0);
        const after = await plan(EMP.both);
        expect(after.installment_schedule).toEqual(marked.installment_schedule);
        expect(Number(after.recovered_amount)).toBe(Number(marked.recovered_amount));

        // The next cycle's payroll takes the next slot as usual.
        const next = await payrollLine(EMP.both, C2);
        await loans.applySnapshotToLine(next.payroll_run_id, EMP.both);
        await deposits.applySnapshotToLine(next.payroll_run_id, EMP.both);
        const nextSnap = await prisma.payroll_run_lines.findUniqueOrThrow({ where: { id: next.id } });
        expect(Number(nextSnap.loan_deduction)).toBe(3000);
        expect(Number(nextSnap.security_deposit_deduction)).toBe(10000);
    });

    it('undo puts the slot back, and is refused once that cycle has a finalized payroll', async () => {
        const view = await hr().get(`/hr/employees/${EMP.npd}/security-deposit`);
        const txn = view.body.data.current.transactions.at(-1);
        const undo = await hr().post(`/hr/employees/${EMP.npd}/security-deposit/collections/${txn.id}/undo`).send({});
        expect(undo.status).toBe(201);
        const current = undo.body.data.current;
        expect(current.recovered_amount).toBe(0);
        expect(current.carried_forward_amount).toBe(0);
        expect(current.next_collection_period_start).toBe(day(C1));
        expect(current.next_due_amount).toBe(10000);

        // EMP.both has a finalized C1 payroll line: its C1 mark can't be undone.
        const both = await hr().get(`/hr/employees/${EMP.both}/security-deposit`);
        const bothTxn = both.body.data.current.transactions.at(-1);
        const refused = await hr().post(`/hr/employees/${EMP.both}/security-deposit/collections/${bothTxn.id}/undo`).send({});
        expect(refused.status).toBe(400);
        expect(refused.body.message).toContain('already been finalized');
    });
});
