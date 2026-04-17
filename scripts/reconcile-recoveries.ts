import { PrismaClient, Prisma } from '@prisma/client';
import fs from 'fs';
import { parse } from 'csv-parse/sync';

/**
 * RECONCILIATION SCRIPT: April Recovery
 * 
 * Logic:
 * 1. Read CC and Receivable from CSV.
 * 2. Find all student_fees where fee_date <= 2026-04-01.
 * 3. Sum total amount in DB.
 * 4. Compare with Receivable.
 * 5. If match (diff=0) or late fee (diff=1000):
 *    - Update student_fees as PAID.
 *    - Update non-VOID vouchers for student as PAID.
 *    - Set voucher_heads balance to 0 and amount_deposited to net_amount.
 */

const prisma = new PrismaClient();

const DRY_RUN = process.env.DRY_RUN === 'false' ? false : true;

async function main() {
    const csvPath = '/Users/aawaizali/Desktop/TAFS/tafs-backend/recoveries-april/extracted_data.csv';
    const logPath = '/Users/aawaizali/Desktop/TAFS/tafs-backend/recoveries-april/recovery_logs_april.txt';
    
    if (DRY_RUN) {
        console.log('--- RUNNING IN DRY_RUN MODE (No DB changes) ---');
    }

    // Initialize/Clear log file
    fs.writeFileSync(logPath, `Recovery Reconciliation Logs - ${new Date().toISOString()}\n`);
    fs.appendFileSync(logPath, `Mode: ${DRY_RUN ? 'DRY_RUN' : 'LIVE'}\n\n`);

    if (!fs.existsSync(csvPath)) {
        console.error(`CSV not found at ${csvPath}`);
        return;
    }

    const fileContent = fs.readFileSync(csvPath, 'utf8');
    const records = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }) as any[];

    console.log(`Processing ${records.length} records...`);

    let successCount = 0;
    let lateFeeCount = 0;
    let mismatchCount = 0;
    let missingCount = 0;

    for (const record of records) {
        const ccRaw = record['C.C.'];
        const receivableRaw = record['Receivable'];

        // Clean CC: removals of .0 if present
        const cc = Math.floor(parseFloat(ccRaw));
        const receivable = parseFloat(receivableRaw);

        if (isNaN(cc)) continue;

        // 1. Fetch relevant fees
        const fees = await prisma.student_fees.findMany({
            where: {
                student_id: cc,
                fee_date: { lte: new Date('2026-04-01') },
            },
        });

        if (fees.length === 0) {
            fs.appendFileSync(logPath, `[MISSING] CC: ${cc} | Receivable: ${receivable} | Reason: No fees found for 2026-04-01 or earlier.\n`);
            missingCount++;
            continue;
        }

        // 2. Sum amounts using Decimal for precision
        const totalDbAmount = fees.reduce(
            (sum, f) => sum.add(new Prisma.Decimal(f.amount?.toString() || '0')), 
            new Prisma.Decimal(0)
        );
        
        const diff = new Prisma.Decimal(receivable).sub(totalDbAmount);

        const isExactMatch = diff.equals(0);
        const isLateFeeMatch = diff.equals(1000);

        if (isExactMatch || isLateFeeMatch) {
            const feeIds = fees.map(f => f.id);
            
            if (!DRY_RUN) {
                await prisma.$transaction(async (tx) => {
                    // Update Fees: Match amount_paid to amount and status to PAID
                    await tx.$executeRaw`
                        UPDATE student_fees 
                        SET amount_paid = amount, status = 'PAID'
                        WHERE id IN (${Prisma.join(feeIds)})
                    `;

                    // Update Vouchers for this student
                    const vouchers = await tx.vouchers.findMany({
                        where: {
                            student_id: cc,
                            status: { not: 'VOID' },
                        },
                        select: { id: true }
                    });
                    
                    const voucherIds = vouchers.map(v => v.id);
                    if (voucherIds.length > 0) {
                        // Mark vouchers as PAID
                        await tx.vouchers.updateMany({
                            where: { id: { in: voucherIds } },
                            data: {
                                status: 'PAID',
                                ...(isLateFeeMatch ? { late_fee_deposited: 1000 } : {})
                            }
                        });

                        // Settle Voucher Heads
                        await tx.$executeRaw`
                            UPDATE voucher_heads
                            SET amount_deposited = net_amount, balance = 0
                            WHERE voucher_id IN (${Prisma.join(voucherIds)})
                        `;
                    }
                });
            }

            const matchType = isLateFeeMatch ? '(LATE FEE MATCH)' : '(EXACT MATCH)';
            fs.appendFileSync(logPath, `[SUCCESS] CC: ${cc} | Receivable: ${receivable} | DB Total: ${totalDbAmount} | Match: ${matchType}\n`);
            
            if (isLateFeeMatch) lateFeeCount++;
            else successCount++;

        } else {
            fs.appendFileSync(logPath, `[MISMATCH] CC: ${cc} | Receivable: ${receivable} | DB Sum: ${totalDbAmount} | Diff: ${diff}\n`);
            mismatchCount++;
        }
    }

    const summary = `
--- PROGRESS SUMMARY ---
Total Records: ${records.length}
Exact Matches: ${successCount}
Late Fee Matches: ${lateFeeCount}
Mismatches: ${mismatchCount}
Missing Fees: ${missingCount}
------------------------
`;
    fs.appendFileSync(logPath, summary);
    console.log(summary);
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
