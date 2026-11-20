/**
 * TAFSD-547: hold back students with arrears in a bulk voucher job, and issue
 * them later from a follow-up job. Unit level, mocked Prisma: the job loop and
 * the follow-up's checks. The DB suite (test/db/bulk-voucher-hold-back-arrears)
 * runs the same flows end to end through the real create().
 */
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import {
    BulkVoucherJobsService,
    HELD_BACK_ARREARS,
    heldBackCcs,
    heldBackReportRow,
} from './bulk-voucher-jobs.service';
import type { StartBulkJobDto } from './dto/start-bulk-job.dto';

const SEP = '2026-09-01';

beforeAll(() => {
    for (const m of ['log', 'debug', 'warn', 'error'] as const) {
        jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
    }
});

function arrears(total: number, rows: Array<{ fee_date: string; isSurcharge?: boolean }> = [], groups = 0) {
    return {
        total_arrears: total,
        total_surcharge: groups * 1000,
        arrear_fee_ids: [],
        surcharge_fee_ids: [],
        surcharge_groups: Array.from({ length: groups }, () => ({})),
        rows: rows.map((r) => ({ isSurcharge: false, ...r })),
    };
}

function student(cc: number, campus_id = 1) {
    return {
        cc,
        full_name: `Student ${cc}`,
        campus_id,
        class_id: 10,
        section_id: 20,
        classes: { description: 'Class VI' },
        sections: { description: 'A' },
    };
}

function workItem(cc: number, dateStr = SEP, extra: Record<string, unknown> = {}) {
    return { cc, dateStr, fees: [{ id: cc * 10, amount: 100, amount_before_discount: 100 }], student: student(cc), academicYear: '2026-2027', ...extra };
}

function build(opts: {
    workItems: any[];
    skips?: any[];
    arrearsByCc?: Record<number, ReturnType<typeof arrears> | Error>;
    jobs?: Record<number, any>;
}) {
    const updates: any[] = [];
    const prisma: any = {
        connectionLimit: 12,
        bulk_voucher_jobs: {
            update: jest.fn(async ({ data }: any) => {
                updates.push(data);
                return {};
            }),
            findUnique: jest.fn(async ({ where }: any) => opts.jobs?.[where.id] ?? null),
            create: jest.fn(async () => ({ id: 99 })),
        },
        student_fees: { findMany: jest.fn(async () => []) },
        campuses: { findMany: jest.fn(async () => [{ id: 1, campus_name: 'Campus A' }]) },
    };
    let nextVoucher = 500;
    const vouchersService: any = {
        resolveGeneratedByName: jest.fn(async () => 'Tester'),
        computeArrears: jest.fn(async (cc: number) => {
            const a = opts.arrearsByCc?.[cc] ?? arrears(0);
            if (a instanceof Error) throw a;
            return a;
        }),
        create: jest.fn(async () => ({ id: nextVoucher++ })),
        generatePdfBuffer: jest.fn(async () => {
            throw new Error('no pdf in unit tests');
        }),
    };
    const studentRecords = [...new Map(opts.workItems.map((w) => [w.cc, w.student])).values()];
    const bulkLogic: any = {
        fetchBaseData: jest.fn(async () => ({ studentRecords, matchingFees: [], existingVouchers: [] })),
        resolveWorkItems: jest.fn(() => ({ workItems: opts.workItems, skips: opts.skips ?? [] })),
    };
    const auditLogs: any = { log: jest.fn(async () => 1) };
    const scope: any = {
        isExempt: jest.fn(() => true),
        whereForStudents: jest.fn(() => ({})),
    };
    const service = new BulkVoucherJobsService(
        prisma,
        vouchersService,
        { sendVoucherIssuedNotification: jest.fn() } as any,
        {} as any,
        { upload: jest.fn() } as any,
        bulkLogic,
        auditLogs,
        scope,
    );
    return { service, prisma, vouchersService, updates, auditLogs };
}

const baseDto = (extra: Partial<StartBulkJobDto> = {}): StartBulkJobDto => ({
    fee_date_from: SEP,
    fee_date_to: '2026-09-28',
    issue_date: SEP,
    due_date: '2026-09-10',
    bank_account_id: 1,
    send_notification: false,
    student_ccs: [1, 2],
    ...extra,
});

async function runProcessJob(service: BulkVoucherJobsService, dto: StartBulkJobDto) {
    await (service as any).processJob(7, dto, [SEP], 'tester', 'Tester', 1);
}

const finalReport = (updates: any[]) => [...updates].reverse().find((u) => Array.isArray(u.report))!.report;

describe('held-back report helpers (TAFSD-547)', () => {
    it('builds the held-back row from computeArrears output', () => {
        const row = heldBackReportRow(
            student(1),
            'Campus A',
            arrears(37990, [{ fee_date: '2026-07-01' }, { fee_date: '2026-08-01' }, { fee_date: '2026-07-01', isSurcharge: true }], 2),
            SEP,
            1,
        );
        expect(row).toEqual({
            cc: 1,
            student_name: 'Student 1',
            status: HELD_BACK_ARREARS,
            reason: 'Held back: arrears of Rs 37,990 over 2 month(s), oldest unpaid fee date 2026-07-01. No voucher issued.',
            arrears_amount: 37990,
            arrears_months: 2,
            oldest_unpaid_fee_date: '2026-07-01',
            arrears_as_of: SEP,
            class_name: 'Class VI',
            section_name: 'A',
            campus_id: 1,
            campus_name: 'Campus A',
            items_held: 1,
        });
    });

    it('lists each held-back cc once, ignoring other rows and junk', () => {
        expect(heldBackCcs(null)).toEqual([]);
        expect(
            heldBackCcs([
                { cc: 3, status: HELD_BACK_ARREARS },
                { cc: 4, status: 'SUCCESS' },
                { cc: 3, status: HELD_BACK_ARREARS },
                { cc: 5, status: HELD_BACK_ARREARS },
                { status: 'INTERRUPTED' },
            ]),
        ).toEqual([3, 5]);
    });
});

describe('bulk job loop with hold_back_arrears (TAFSD-547)', () => {
    it('off: never asks for arrears, issues everyone, writes no held-back counter', async () => {
        const { service, vouchersService, updates, prisma } = build({
            workItems: [workItem(1), workItem(2)],
            arrearsByCc: { 1: arrears(5000, [{ fee_date: '2026-08-01' }], 1) },
        });
        await runProcessJob(service, baseDto());

        expect(vouchersService.computeArrears).not.toHaveBeenCalled();
        expect(vouchersService.create).toHaveBeenCalledTimes(2);
        expect(prisma.campuses.findMany).not.toHaveBeenCalled();
        expect(updates.some((u) => 'held_back_count' in u)).toBe(false);
        expect(finalReport(updates).map((r: any) => [r.cc, r.status])).toEqual([[1, 'SUCCESS'], [2, 'SUCCESS']]);
    });

    it('on: holds back the student with arrears (as of their first fee date), issues the rest', async () => {
        const { service, vouchersService, updates } = build({
            workItems: [workItem(1), workItem(2)],
            arrearsByCc: { 1: arrears(18995, [{ fee_date: '2026-08-01' }], 1) },
        });
        await runProcessJob(service, baseDto({ hold_back_arrears: true }));

        expect(vouchersService.computeArrears).toHaveBeenCalledWith(1, new Date(SEP), false);
        expect(vouchersService.computeArrears).toHaveBeenCalledWith(2, new Date(SEP), false);
        expect(vouchersService.create).toHaveBeenCalledTimes(1);
        expect(vouchersService.create.mock.calls[0][0].student_id).toBe(2);
        expect(updates).toContainEqual(expect.objectContaining({ held_back_count: { increment: 1 } }));

        const report = finalReport(updates);
        expect(report.find((r: any) => r.cc === 1)).toMatchObject({
            status: HELD_BACK_ARREARS,
            arrears_amount: 18995,
            arrears_months: 1,
            oldest_unpaid_fee_date: '2026-08-01',
            campus_name: 'Campus A',
        });
        expect(report.find((r: any) => r.cc === 2)).toMatchObject({ status: 'SUCCESS' });
    });

    it('on: a multi-month student is checked once, as of the earliest month, and held back whole', async () => {
        const { service, vouchersService, updates } = build({
            workItems: [workItem(1, SEP), workItem(1, '2026-10-01')],
            arrearsByCc: { 1: arrears(100, [{ fee_date: '2026-08-01' }], 1) },
        });
        await runProcessJob(service, baseDto({ hold_back_arrears: true, fee_date_to: '2026-10-28' }));

        expect(vouchersService.computeArrears).toHaveBeenCalledTimes(1);
        expect(vouchersService.computeArrears).toHaveBeenCalledWith(1, new Date(SEP), false);
        expect(vouchersService.create).not.toHaveBeenCalled();
        expect(finalReport(updates)).toEqual([expect.objectContaining({ cc: 1, status: HELD_BACK_ARREARS, items_held: 2 })]);
    });

    it('on: the "split off a partially-paid period" note is only written for a student actually issued', async () => {
        const splitSkip = (cc: number) => ({
            cc,
            student_name: `Student ${cc}`,
            status: 'SKIPPED',
            reason: 'Existing voucher ... partially paid — left untouched. A new voucher was split off ...',
            dateStr: SEP,
            partially_paid: true,
        });
        const { service, updates } = build({
            workItems: [workItem(1, SEP, { splitFromPartiallyPaid: true }), workItem(2, SEP, { splitFromPartiallyPaid: true })],
            skips: [splitSkip(1), splitSkip(2)],
            arrearsByCc: { 1: arrears(500, [{ fee_date: '2026-08-01' }], 1) },
        });
        await runProcessJob(service, baseDto({ hold_back_arrears: true }));

        const report = finalReport(updates);
        expect(report.filter((r: any) => r.cc === 1).map((r: any) => r.status)).toEqual([HELD_BACK_ARREARS]);
        expect(report.filter((r: any) => r.cc === 2).map((r: any) => r.status).sort()).toEqual(['SKIPPED', 'SUCCESS']);
    });

    it('on: if the arrears check fails, the student is not issued and is reported failed', async () => {
        const { service, vouchersService, updates } = build({
            workItems: [workItem(1)],
            arrearsByCc: { 1: new Error('db down') },
        });
        await runProcessJob(service, baseDto({ hold_back_arrears: true }));

        expect(vouchersService.create).not.toHaveBeenCalled();
        expect(finalReport(updates)).toEqual([
            expect.objectContaining({ cc: 1, status: 'FAILED', error: 'Arrears check failed, no voucher issued: db down' }),
        ]);
    });
});

describe('startHeldBackJob (TAFSD-547)', () => {
    const user: any = { sub: 'u1', username: 'tester', role: 'SUPER_ADMIN' };
    const sourceJob = (extra: Record<string, unknown> = {}) => ({
        id: 5,
        status: 'DONE',
        created_by: 'someone',
        campus_ids: [1],
        class_ids: [10],
        section_ids: [],
        report: [
            { cc: 1, status: HELD_BACK_ARREARS },
            { cc: 2, status: 'SUCCESS' },
            { cc: 3, status: HELD_BACK_ARREARS },
        ],
        ...extra,
    });

    function withStartSpy(jobs: Record<number, any>) {
        const built = build({ workItems: [], jobs });
        const startJob = jest.spyOn(built.service, 'startJob').mockResolvedValue({ job_id: 6 });
        return { ...built, startJob };
    }

    it('starts a job for exactly the held-back students, linked to the source, never regenerating', async () => {
        const { service, startJob } = withStartSpy({ 5: sourceJob() });
        const res = await service.startHeldBackJob(5, { ...baseDto(), student_ccs: undefined, skip_already_issued: false, due_date: '2026-09-20' } as any, user);

        expect(res).toEqual({ job_id: 6, source_job_id: 5, student_count: 2 });
        const [dto, createdBy, , , opts] = startJob.mock.calls[0];
        expect(dto).toMatchObject({
            student_ccs: [1, 3],
            skip_already_issued: true,
            hold_back_arrears: false,
            due_date: '2026-09-20',
            campus_ids: [1],
            class_ids: [10],
        });
        expect(createdBy).toBe('tester');
        expect(opts).toEqual({ sourceJobId: 5 });
    });

    it('can narrow the list and keep holding back, but never add a student', async () => {
        const { service, startJob } = withStartSpy({ 5: sourceJob() });
        await service.startHeldBackJob(5, { ...baseDto(), student_ccs: [3], hold_back_arrears: true } as any, user);
        expect(startJob.mock.calls[0][0]).toMatchObject({ student_ccs: [3], hold_back_arrears: true });

        await expect(
            service.startHeldBackJob(5, { ...baseDto(), student_ccs: [1, 2] } as any, user),
        ).rejects.toThrow(new BadRequestException('Job #5 did not hold back student CC 2.'));
        expect(startJob).toHaveBeenCalledTimes(1);
    });

    it('refuses a missing job, an unfinished one, and one that held back nobody', async () => {
        const { service, startJob } = withStartSpy({
            5: sourceJob({ status: 'PROCESSING' }),
            8: sourceJob({ report: [{ cc: 1, status: 'SUCCESS' }] }),
        });
        await expect(service.startHeldBackJob(4, baseDto() as any, user)).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.startHeldBackJob(5, baseDto() as any, user)).rejects.toThrow('has not finished yet');
        await expect(service.startHeldBackJob(8, baseDto() as any, user)).rejects.toThrow('held back no students');
        expect(startJob).not.toHaveBeenCalled();
    });

    it('hides a job the caller cannot see', async () => {
        const built = build({ workItems: [], jobs: { 5: sourceJob() } });
        const scoped: any = { sub: 'u2', username: 'clerk', role: 'FINANCE_CLERK' };
        (built.service as any).scope.isExempt = jest.fn(() => false);
        (built.service as any).scope.assertCampus = jest.fn(() => {
            throw new Error('out of scope');
        });
        await expect(built.service.startHeldBackJob(5, baseDto() as any, scoped)).rejects.toBeInstanceOf(NotFoundException);
    });
});
