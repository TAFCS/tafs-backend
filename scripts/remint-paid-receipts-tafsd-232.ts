/**
 * ONE-OFF (TAFSD-232): re-mint paid receipts frozen with the wrong totals.
 *
 * Before #232, the paid half of a split printed an ARREARS line that included
 * installments already billed on the balance voucher, and a flat 1,000 late fee
 * the voucher never stored — so the receipt did not add up (10260012307 printed
 * 12,955 + 2,000 against 13,289, after due 14,289). Paid receipts are write-once
 * (finance CLAUDE.md, invariant 8), so the deployed fix only reaches receipts
 * minted after it. This script is the deliberate, logged exception.
 *
 * For each target it:
 *   1. checks the voucher is PAID, belongs to the expected cc, is a split child,
 *      and still has a frozen paid_pdf_url;
 *   2. clears paid_pdf_url / paid_pdf_filename / paid_pdf_generated_at;
 *   3. calls VouchersService.generatePdf(), which renders with the CURRENT code,
 *      uploads to the same deterministic key (link + QR unchanged) and re-freezes;
 *   4. writes an audit_logs row.
 * No amounts, heads, deposits or statuses are touched, and no notification is sent.
 *
 * Run it from a checkout that contains the #232 fix — it renders with local code
 * and uploads to whatever storage .env points at.
 *
 * Usage:
 *   npx ts-node scripts/remint-paid-receipts-tafsd-232.ts                  # dry run, all targets
 *   npx ts-node scripts/remint-paid-receipts-tafsd-232.ts --ids 12307      # dry run, one voucher
 *   npx ts-node scripts/remint-paid-receipts-tafsd-232.ts --ids 12307 --commit
 *
 * Afterwards purge the printed CDN paths, or the edge may serve the old file
 * until its cache expires.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { VouchersService } from '../src/modules/vouchers/vouchers.service';
import { AuditLogsService } from '../src/modules/audit-logs/audit-logs.service';
import { PrismaService } from '../prisma/prisma.service';

const COMMIT = process.argv.includes('--commit');
const CHANGED_BY = 'remint-paid-receipts-tafsd-232';

// Paid split children whose frozen receipt carries a "missed arrear" installment
// that sits on the balance voucher — found 2026-10-01.
const TARGETS: { cc: number; voucherId: number }[] = [
    { cc: 7789, voucherId: 9090 },
    { cc: 4584, voucherId: 10176 },
    { cc: 7532, voucherId: 10679 },
    { cc: 7175, voucherId: 11075 },
    { cc: 6536, voucherId: 12235 },
    { cc: 7687, voucherId: 12262 },
    { cc: 7332, voucherId: 12307 },
];

function selectedTargets() {
    const i = process.argv.indexOf('--ids');
    if (i < 0) return TARGETS;
    const ids = (process.argv[i + 1] ?? '').split(',').map(Number).filter(Boolean);
    const unknown = ids.filter((id) => !TARGETS.some((t) => t.voucherId === id));
    if (unknown.length) throw new Error(`Not a reviewed target: ${unknown.join(', ')}`);
    return TARGETS.filter((t) => ids.includes(t.voucherId));
}

async function main() {
    const targets = selectedTargets();
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    const prisma = app.get(PrismaService);
    const vouchers = app.get(VouchersService);
    const auditLogs = app.get(AuditLogsService);

    console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} — ${targets.length} target(s)\n`);
    const purge: string[] = [];
    let done = 0, skipped = 0;

    for (const { cc, voucherId } of targets) {
        const v = await prisma.vouchers.findUnique({
            where: { id: voucherId },
            select: {
                id: true, student_id: true, status: true, voucher_number: true,
                split_parent_id: true, paid_pdf_url: true, paid_pdf_filename: true,
            },
        });
        const reason =
            !v ? 'not found'
            : v.student_id !== cc ? `belongs to cc ${v.student_id}, expected ${cc}`
            : v.status !== 'PAID' ? `status ${v.status}`
            : v.split_parent_id == null ? 'not a split child'
            : !v.paid_pdf_url ? 'no frozen receipt'
            : null;
        if (reason) {
            console.log(`SKIP  #${voucherId} (cc ${cc}): ${reason}`);
            skipped++;
            continue;
        }

        console.log(`${COMMIT ? 'REMINT' : 'WOULD '} #${voucherId} ${v!.voucher_number} (cc ${cc}) ${v!.paid_pdf_url}`);
        if (!COMMIT) continue;

        await prisma.vouchers.updateMany({
            where: { id: voucherId, paid_pdf_url: v!.paid_pdf_url },
            data: { paid_pdf_url: null, paid_pdf_filename: null, paid_pdf_generated_at: null },
        });
        const minted = await vouchers.generatePdf(voucherId);
        await auditLogs.log({
            entity_type: 'VOUCHER',
            entity_id: String(voucherId),
            action: 'UPDATED',
            field: 'paid_pdf_url',
            old_value: v!.paid_pdf_url,
            new_value: minted.pdf_url ?? null,
            changed_by: CHANGED_BY,
            student_id: cc,
            note: `Paid receipt re-minted after the TAFSD-232 PDF totals fix (wrong arrears / after-due lines). No amounts changed.`,
        });
        console.log(`      -> ${minted.pdf_url}`);
        if (minted.pdf_url) purge.push(new URL(minted.pdf_url).pathname.replace(/^\//, ''));
        done++;
    }

    console.log(`\n${COMMIT ? 're-minted' : 'would re-mint'}: ${COMMIT ? done : targets.length - skipped}, skipped: ${skipped}`);
    if (purge.length) console.log(`\nPurge from the CDN:\n${purge.join('\n')}`);
    await app.close();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
