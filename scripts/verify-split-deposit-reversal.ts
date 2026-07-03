/**
 * Verifies the multi-deposit split-reversal fix end-to-end against a real database.
 *
 * Scenario (the reported case): one voucher with 3 heads —
 *   August tuition (2000), a late arrear surcharge (1000), September tuition (2000).
 *   D1 pays August + surcharge (3000). D2 pays 1000 of September (partial).
 *   Split the (now PARTIALLY_PAID) voucher into a PAID child + UNPAID balance child.
 *   Reverse D1, then D2, asserting DB state at each stage.
 *
 * Expected (post-fix):
 *   - Reverse D1  → paid child steps PAID→PARTIALLY_PAID; balance child + VOID original
 *                   stay intact; D2 and its allocation survive; nothing orphaned.
 *   - Reverse D2  → the split fully merges back: original reactivated (UNPAID/OVERDUE)
 *                   with heads [Aug 2000, Sep 2000] and restored surcharge; both children
 *                   deleted; D2 deleted; September back to a single 2000 fee row.
 *   - Regression  → a single deposit covering everything, split, then one reversal still
 *                   fully un-splits (proves the pre-existing clean path is untouched).
 *
 * SAFETY: this script CREATES and DELETES voucher/fee/deposit rows. Every row it writes is
 * tagged academic_year='VERIFYX' and torn down in a finally block; deposits are tracked by
 * id. It refuses to run unless VERIFY_SPLIT_REVERSAL=1 is set, and prints the target DB host
 * first. Run it ONLY against a dev/test database.
 *
 * Usage: VERIFY_SPLIT_REVERSAL=1 npm run verify:split-reversal
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { VouchersService } from '../src/modules/vouchers/vouchers.service';

const MARKER = 'VERIFYX'; // academic_year tag for all rows this script creates

function loadEnvFile(): void {
    const envPath = resolve(__dirname, '../.env');
    if (!existsSync(envPath)) return;
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        if (process.env[key] === undefined) process.env[key] = trimmed.slice(idx + 1).trim();
    }
}

// ── tiny assertion helpers ──────────────────────────────────────────────────
let passed = 0;
function assert(cond: boolean, msg: string): void {
    if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
    passed++;
    console.log(`  ✓ ${msg}`);
}
const num = (d: any): number => (d == null ? 0 : Number(d));

// ── permissive no-op stubs for the peripheral deps (the flow under test is pure DB) ──
// storage.upload no-ops on its own when storage isn't configured, but we stub anyway so the
// script never depends on env; pdf returns a dummy buffer; audit/notification/bulk are inert.
function buildService(prisma: PrismaService): VouchersService {
    const storageStub: any = {
        upload: async (key: string) => `mock://${key}`,
        getPublicUrl: (key: string) => `mock://${key}`,
        deleteByUrl: async () => undefined,
    };
    const pdfStub: any = { generateVoucherPdf: async () => Buffer.from('%PDF-1.4') };
    const auditStub: any = { log: async () => undefined };
    const inert: any = new Proxy({}, { get: () => async () => undefined });
    return new VouchersService(prisma, storageStub, pdfStub, inert, auditStub, inert);
}

async function main(): Promise<void> {
    loadEnvFile();

    if (process.env.VERIFY_SPLIT_REVERSAL !== '1') {
        throw new Error(
            'Refusing to run: set VERIFY_SPLIT_REVERSAL=1 to allow this script to write to the DB. ' +
            'Run it ONLY against a dev/test database.',
        );
    }
    const dbHost = (process.env.DATABASE_URL || '').replace(/:\/\/[^@]*@/, '://***@');
    console.log(`Target DATABASE_URL: ${dbHost || '(unset)'}\n`);

    const prisma = new PrismaService();
    await prisma.$connect();
    const service = buildService(prisma);

    // Reuse an existing voucher's FKs (student/campus/class/bank/section) — guaranteed valid.
    const ref = await prisma.vouchers.findFirst({
        select: { student_id: true, campus_id: true, class_id: true, bank_account_id: true, section_id: true },
    });
    if (!ref) throw new Error('No existing voucher found to borrow valid FK references from.');
    const feeType = await prisma.fee_types.findFirst({ select: { id: true } });
    const feeTypeId = feeType?.id ?? null;
    const studentId = ref.student_id;

    const feeDate = new Date('2000-08-01');       // fixed, arbitrary test period
    const issue = new Date('2000-08-01');
    const due = new Date('2000-08-15');
    const createdDepositIds: number[] = [];

    // Clean any leftovers from a prior aborted run before we start.
    await teardown(prisma, studentId, []);

    try {
        // ── helper: build a fresh 3-head voucher for `studentId` ──────────────
        async function makeVoucher(): Promise<{ voucherId: number; augHead: number; surHead: number; sepHead: number; surchargeId: number }> {
            const mkFee = (amount: number) =>
                prisma.student_fees.create({
                    data: {
                        student_id: studentId, fee_type_id: feeTypeId, academic_year: MARKER,
                        target_month: 8, month: 8, fee_date: feeDate, status: 'ISSUED' as any,
                        amount: new Prisma.Decimal(amount), amount_before_discount: new Prisma.Decimal(amount),
                        amount_paid: new Prisma.Decimal(0),
                    } as any,
                });
            const aug = await mkFee(2000);
            const sep = await mkFee(2000);

            const voucher = await prisma.vouchers.create({
                data: {
                    student_id: studentId, campus_id: ref!.campus_id, class_id: ref!.class_id,
                    bank_account_id: ref!.bank_account_id, section_id: ref!.section_id,
                    issue_date: issue, due_date: due, status: 'UNPAID', late_fee_charge: false,
                    academic_year: MARKER, month: 8, fee_date: feeDate,
                    total_payable_before_due: new Prisma.Decimal(5000),
                    total_payable_after_due: new Prisma.Decimal(5000),
                } as any,
            });
            const augHead = await prisma.voucher_heads.create({
                data: { voucher_id: voucher.id, student_fee_id: aug.id, net_amount: new Prisma.Decimal(2000), balance: new Prisma.Decimal(2000), amount_deposited: new Prisma.Decimal(0) } as any,
            });
            const sepHead = await prisma.voucher_heads.create({
                data: { voucher_id: voucher.id, student_fee_id: sep.id, net_amount: new Prisma.Decimal(2000), balance: new Prisma.Decimal(2000), amount_deposited: new Prisma.Decimal(0) } as any,
            });
            const surcharge = await prisma.voucher_arrear_surcharges.create({
                data: { voucher_id: voucher.id, arrear_fee_date: feeDate, arrear_month: 8, arrear_year: MARKER, amount: new Prisma.Decimal(1000), amount_paid: new Prisma.Decimal(0) } as any,
            });
            return { voucherId: voucher.id, augHead: augHead.id, surHead: -1, sepHead: sepHead.id, surchargeId: surcharge.id };
        }

        async function lastDepositId(): Promise<number> {
            const d = await prisma.deposits.findFirst({ where: { student_id: studentId }, orderBy: { id: 'desc' } });
            if (!d) throw new Error('expected a deposit row');
            createdDepositIds.push(d.id);
            return d.id;
        }

        // ══════════════════════════════════════════════════════════════════════
        console.log('SCENARIO A — two deposits, reverse one at a time');
        // ══════════════════════════════════════════════════════════════════════
        const A = await makeVoucher();

        // D1: August (2000) + surcharge (1000)
        await service.recordDeposit(A.voucherId, {
            amount: 3000, distributions: { [A.augHead]: 2000 },
            surcharge_allocations: [{ surcharge_id: A.surchargeId, amount: 1000 }],
        } as any, 'verify');
        const d1 = await lastDepositId();

        // D2: 1000 of September (partial)
        await service.recordDeposit(A.voucherId, { amount: 1000, distributions: { [A.sepHead]: 1000 } } as any, 'verify');
        const d2 = await lastDepositId();

        let v = await prisma.vouchers.findUnique({ where: { id: A.voucherId } });
        assert(v?.status === 'PARTIALLY_PAID', 'voucher is PARTIALLY_PAID after two deposits');

        // Split
        await service.splitPartiallyPaid(A.voucherId, { issue_date: issue.toISOString(), due_date: due.toISOString() } as any, 'verify');
        let children = await prisma.vouchers.findMany({ where: { split_parent_id: A.voucherId } });
        v = await prisma.vouchers.findUnique({ where: { id: A.voucherId } });
        assert(v?.status === 'VOID', 'original voucher is VOID after split');
        assert(children.length === 2, 'exactly two split children created');
        const paid = children.find((c) => c.status === 'PAID');
        const balance = children.find((c) => c.status === 'UNPAID' || c.status === 'OVERDUE');
        assert(!!paid, 'a PAID child exists');
        assert(!!balance, 'an UNPAID/OVERDUE balance child exists');
        const allocsOnPaid = await prisma.deposit_allocations.findMany({ where: { voucher_id: paid!.id } });
        assert(new Set(allocsOnPaid.map((a) => a.deposit_id)).size === 2, 'both deposits allocate onto the PAID child');

        // ── Reverse D1 (non-last) ──
        console.log('  -- reverse D1 (first of two) --');
        await service.clearDeposit(paid!.id, d1, 'verify');
        const paidAfterD1 = await prisma.vouchers.findUnique({ where: { id: paid!.id } });
        const balAfterD1 = await prisma.vouchers.findUnique({ where: { id: balance!.id } });
        const origAfterD1 = await prisma.vouchers.findUnique({ where: { id: A.voucherId } });
        const d2Row = await prisma.deposits.findUnique({ where: { id: d2 } });
        const d2Allocs = await prisma.deposit_allocations.findMany({ where: { deposit_id: d2 } });
        const orphanAllocs = await prisma.deposit_allocations.findMany({ where: { deposit_id: d1 } });
        assert(paidAfterD1?.status === 'PARTIALLY_PAID', 'paid child steps down to PARTIALLY_PAID (not destroyed)');
        assert(!!balAfterD1 && balAfterD1.status !== 'VOID', 'balance child still intact');
        assert(origAfterD1?.status === 'VOID', 'original still VOID (split not torn down)');
        assert(!!d2Row, 'D2 deposit row still exists');
        assert(d2Allocs.length > 0 && d2Allocs.every((a) => a.voucher_id === paid!.id), 'D2 allocation preserved on the paid child');
        assert(orphanAllocs.length === 0, 'no D1 allocations orphaned');

        // ── Reverse D2 (last) → full merge ──
        console.log('  -- reverse D2 (last) --');
        await service.clearDeposit(paid!.id, d2, 'verify');
        const origMerged = await prisma.vouchers.findUnique({ where: { id: A.voucherId }, include: { voucher_heads: true, voucher_arrear_surcharges: true } });
        const childrenAfter = await prisma.vouchers.findMany({ where: { split_parent_id: A.voucherId } });
        const d2After = await prisma.deposits.findUnique({ where: { id: d2 } });
        const sepFees = await prisma.student_fees.findMany({ where: { student_id: studentId, academic_year: MARKER, fee_date: feeDate } });
        assert(origMerged?.status === 'UNPAID' || origMerged?.status === 'OVERDUE', 'original reactivated (UNPAID/OVERDUE)');
        assert(childrenAfter.length === 0, 'both split children deleted');
        assert(!d2After, 'D2 deposit deleted');
        assert(origMerged!.voucher_heads.length === 2, 'original has its 2 heads back (Aug + Sep merged)');
        const headTotal = origMerged!.voucher_heads.reduce((s, h) => s + num(h.net_amount), 0);
        assert(headTotal === 4000, 'merged head net totals 4000 (2000 + 2000)');
        assert(origMerged!.voucher_arrear_surcharges.every((s) => num(s.amount_paid) === 0), 'surcharge payment reset to 0');
        const sepPartials = sepFees.filter((f) => (f.description_prefix ?? '').startsWith('PARTIAL PAYMENT OF'));
        assert(sepPartials.length === 0, 'no leftover PARTIAL PAYMENT OF September fee rows');

        // ══════════════════════════════════════════════════════════════════════
        console.log('\nSCENARIO B — regression: single deposit, one reversal, clean un-split');
        // ══════════════════════════════════════════════════════════════════════
        const B = await makeVoucher();
        // one deposit covers August + surcharge + 1000 of September (=> September partial)
        await service.recordDeposit(B.voucherId, {
            amount: 4000, distributions: { [B.augHead]: 2000, [B.sepHead]: 1000 },
            surcharge_allocations: [{ surcharge_id: B.surchargeId, amount: 1000 }],
        } as any, 'verify');
        const dB = await lastDepositId();
        await service.splitPartiallyPaid(B.voucherId, { issue_date: issue.toISOString(), due_date: due.toISOString() } as any, 'verify');
        const bChildren = await prisma.vouchers.findMany({ where: { split_parent_id: B.voucherId } });
        const bPaid = bChildren.find((c) => c.status === 'PAID')!;
        await service.clearDeposit(bPaid.id, dB, 'verify');
        const bOrig = await prisma.vouchers.findUnique({ where: { id: B.voucherId }, include: { voucher_heads: true } });
        const bChildrenAfter = await prisma.vouchers.findMany({ where: { split_parent_id: B.voucherId } });
        assert(bOrig?.status === 'UNPAID' || bOrig?.status === 'OVERDUE', 'single-deposit: original reactivated');
        assert(bChildrenAfter.length === 0, 'single-deposit: children deleted (clean full-undo still works)');
        assert(bOrig!.voucher_heads.length === 2, 'single-deposit: original heads restored');

        console.log(`\n✅ ALL ${passed} ASSERTIONS PASSED`);
    } finally {
        await teardown(prisma, studentId, createdDepositIds);
        await prisma.$disconnect();
    }
}

/** Remove every row this script may have created, in FK-safe order. Best-effort/idempotent. */
async function teardown(prisma: PrismaService, studentId: number, depositIds: number[]): Promise<void> {
    try {
        const vouchers = await prisma.vouchers.findMany({ where: { student_id: studentId, academic_year: MARKER }, select: { id: true } });
        const vIds = vouchers.map((v) => v.id);
        // allocations first (NoAction toward vouchers/fees); deposit cascade also covers theirs
        await prisma.deposit_allocations.deleteMany({ where: { OR: [{ voucher_id: { in: vIds } }, { deposit_id: { in: depositIds } }] } });
        if (depositIds.length) await prisma.deposits.deleteMany({ where: { id: { in: depositIds } } });
        if (vIds.length) await prisma.vouchers.deleteMany({ where: { id: { in: vIds } } }); // cascades heads + surcharges
        await prisma.student_fees.deleteMany({ where: { student_id: studentId, academic_year: MARKER } });
    } catch (err: any) {
        console.warn(`  (teardown warning: ${err?.message})`);
    }
}

main().catch((err) => {
    console.error(`\n❌ ${err?.message ?? err}`);
    process.exit(1);
});
