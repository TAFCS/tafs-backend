import { PrismaClient, Prisma } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === 'false' ? false : true;

async function main() {
    const logPath = '/Users/aawaizali/Desktop/TAFS/tafs-backend/recoveries-april/cleanup_logs.txt';
    fs.writeFileSync(logPath, `Recovery Cleanup Logs - ${new Date().toISOString()}\n`);
    fs.appendFileSync(logPath, `Mode: ${DRY_RUN ? 'DRY_RUN' : 'LIVE'}\n\n`);

    if (DRY_RUN) console.log('--- RUNNING IN DRY_RUN MODE ---');

    // ─── PART A: MISMATCHES ──────────────────────────────────────
    const mismatchPath = '/Users/aawaizali/Desktop/TAFS/tafs-backend/recoveries-april/mismatches.txt';
    if (fs.existsSync(mismatchPath)) {
        const lines = fs.readFileSync(mismatchPath, 'utf8').split('\n');
        const mismatchCcs = new Set<number>();
        for (const line of lines) {
            const match = line.match(/CC: (\d+)/);
            if (match) mismatchCcs.add(parseInt(match[1]));
        }

        console.log(`Processing ${mismatchCcs.size} mismatched students...`);
        for (const cc of mismatchCcs) {
            await processMismatchStudent(cc, logPath);
        }
    }

    // ─── PART B: PARTIAL PAYMENTS ───────────────────────────────
    const partials = [
        { cc: 7482, remaining: 2500 },
        { cc: 6879, remaining: 1000 },
        { cc: 6771, remaining: 3200 },
        { cc: 6821, remaining: 1400 },
        { cc: 6852, remaining: 5980 },
        { cc: 7241, remaining: 835 },
    ];

    console.log(`Processing ${partials.length} partial payment students...`);
    for (const p of partials) {
        await processPartialStudent(p.cc, p.remaining, logPath);
    }

    console.log('Done. Check cleanup_logs.txt for details.');
}

async function processMismatchStudent(cc: number, logPath: string) {
    const fees = await prisma.student_fees.findMany({
        where: {
            student_id: cc,
            fee_date: { lte: new Date('2026-04-01') },
        },
    });

    if (fees.length === 0) {
        fs.appendFileSync(logPath, `[MISMATCH-SKIP] CC: ${cc} | No fees found <= 2026-04-01\n`);
        return;
    }

    if (!DRY_RUN) {
        await prisma.$transaction(async (tx) => {
            const feeIds = fees.map(f => f.id);
            await tx.$executeRaw`UPDATE student_fees SET amount_paid = amount, status = 'PAID' WHERE id IN (${Prisma.join(feeIds)})`;
            
            const vouchers = await tx.vouchers.findMany({
                where: { student_id: cc, fee_date: { lte: new Date('2026-04-01') }, status: { not: 'VOID' } },
            });
            const vIds = vouchers.map(v => v.id);
            if (vIds.length > 0) {
                await tx.vouchers.updateMany({ where: { id: { in: vIds } }, data: { status: 'PAID' } });
                await tx.$executeRaw`UPDATE voucher_heads SET amount_deposited = net_amount, balance = 0 WHERE voucher_id IN (${Prisma.join(vIds)})`;
            }
        });
    }
    fs.appendFileSync(logPath, `[MISMATCH-SUCCESS] CC: ${cc} | Marked ${fees.length} fees as PAID\n`);
}

async function processPartialStudent(cc: number, remaining: number, logPath: string) {
    const allFees = await prisma.student_fees.findMany({
        where: {
            student_id: cc,
            fee_date: { lte: new Date('2026-04-01') },
        },
        orderBy: { fee_date: 'asc' }
    });

    if (allFees.length === 0) {
        fs.appendFileSync(logPath, `[PARTIAL-SKIP] CC: ${cc} | No fees found <= 2026-04-01\n`);
        return;
    }

    const preAprilFees = allFees.filter(f => f.fee_date! < new Date('2026-04-01'));
    const aprilFees = allFees.filter(f => f.fee_date!.getTime() === new Date('2026-04-01').getTime());

    if (!DRY_RUN) {
        await prisma.$transaction(async (tx) => {
            // 1. Mark pre-April as fully PAID
            if (preAprilFees.length > 0) {
                const ids = preAprilFees.map(f => f.id);
                await tx.$executeRaw`UPDATE student_fees SET amount_paid = amount, status = 'PAID' WHERE id IN (${Prisma.join(ids)})`;
            }

            // 2. Mark April as PARTIALLY PAID
            if (aprilFees.length > 0) {
                const totalApril = aprilFees.reduce((sum, f) => sum + Number(f.amount || 0), 0);
                let toKeepPaying = totalApril - remaining;
                if (toKeepPaying < 0) toKeepPaying = 0;

                for (const f of aprilFees) {
                    const amt = Number(f.amount || 0);
                    const pay = Math.min(amt, toKeepPaying);
                    toKeepPaying -= pay;

                    const status = pay >= amt ? 'PAID' : (pay > 0 ? 'PARTIALLY_PAID' : 'ISSUED');
                    await tx.student_fees.update({
                        where: { id: f.id },
                        data: { amount_paid: pay, status: status as any }
                    });
                }

                // 3. Update Vouchers for April
                const aprilVoucher = await tx.vouchers.findFirst({
                    where: { student_id: cc, fee_date: new Date('2026-04-01'), status: { not: 'VOID' } },
                    include: { voucher_heads: true }
                });

                if (aprilVoucher) {
                    await tx.vouchers.update({
                        where: { id: aprilVoucher.id },
                        data: { status: 'PARTIALLY_PAID' }
                    });

                    // Sync voucher_heads with student_fees amount_paid
                    for (const vh of aprilVoucher.voucher_heads) {
                        const fee = await tx.student_fees.findUnique({ where: { id: vh.student_fee_id } });
                        if (fee) {
                            const dep = Number(fee.amount_paid || 0);
                            const bal = Math.max(0, Number(vh.net_amount) - dep);
                            await tx.voucher_heads.update({
                                where: { id: vh.id },
                                data: { amount_deposited: dep, balance: bal }
                            });
                        }
                    }
                }
            }
        });
    }

    fs.appendFileSync(logPath, `[PARTIAL-SUCCESS] CC: ${cc} | Remaining Set to ${remaining}\n`);
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
