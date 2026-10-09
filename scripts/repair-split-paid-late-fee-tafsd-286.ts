/**
 * ONE-OFF (TAFSD-286): repair PAID split children missing the due-date late fee
 * in stored totals, then re-mint their frozen PAID receipts.
 *
 * Before #285, splitPartiallyPaid() copied late_fee_deposited onto the PAID
 * child but left total_payable_after_due = total_payable_before_due. The receipt
 * therefore printed only the fee total (e.g. 99,000) with no LATE PAYMENT
 * SURCHARGE / PAYABLE AFTER DUE DATE gap (agreed layout: 99,000 / 1,000 /
 * 100,000). #285 fixes new splits only. Paid receipts are write-once (finance
 * CLAUDE.md, invariant 8), so already-frozen ones need this deliberate,
 * logged exception.
 *
 * Finance gate:
 *   1. Run dry run (default) against the live DB — it auto-discovers candidates
 *      and prints a review table. No writes.
 *   2. Finance signs off on the list (or a subset).
 *   3. `npm run build`  (required — PDF remint needs dist/ voucher-pdf.worker.js)
 *   4. Re-run with --commit (optionally --ids of the reviewed subset).
 *
 * On --commit, for each candidate:
 *   1. sets total_payable_after_due = before_due + late_fee_deposited
 *      (heads, deposits, allocations, statuses, late_fee_deposited untouched);
 *   2. if paid_pdf_url is set: clears paid_pdf_* , calls generatePdf(), which
 *      renders with current code, uploads to the same deterministic key, and
 *      re-freezes. On remint failure the previous paid_pdf_url is restored so
 *      the receipt is not left unlinked.
 *   3. writes audit_logs rows for both the totals fix and the receipt remint.
 * No notification is sent.
 *
 * Candidate predicate (totals):
 *   status = 'PAID'
 *   AND split_parent_id IS NOT NULL
 *   AND late_fee_deposited > 0
 *   AND (after_due − before_due) <> late_fee_deposited
 *
 * Remint-only (--remint-ids): PAID split children whose totals are already
 * correct but paid_pdf_url is null (e.g. a prior --commit cleared the URL then
 * failed mid-render). Remints those ids without touching amounts.
 *
 * Usage:
 *   npx ts-node scripts/repair-split-paid-late-fee-tafsd-286.ts              # dry run
 *   npx ts-node scripts/repair-split-paid-late-fee-tafsd-286.ts --ids 1,2
 *   npm run build
 *   npx ts-node scripts/repair-split-paid-late-fee-tafsd-286.ts --commit
 *   npx ts-node scripts/repair-split-paid-late-fee-tafsd-286.ts --remint-ids 8721 --commit
 *
 * Afterwards purge the printed CDN paths, or the edge may serve the old file
 * until its cache expires. Re-run dry run afterwards — expect 0 candidates.
 */
import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { VouchersService } from '../src/modules/vouchers/vouchers.service';
import { AuditLogsService } from '../src/modules/audit-logs/audit-logs.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveVoucherPdfWorkerFilename } from '../src/modules/voucher-pdf/voucher-pdf.pool';

const COMMIT = process.argv.includes('--commit');
const CHANGED_BY = 'repair-split-paid-late-fee-tafsd-286';

function parseIdsFlag(flag: string): number[] | null {
    const i = process.argv.indexOf(flag);
    if (i < 0) return null;
    const ids = (process.argv[i + 1] ?? '').split(',').map(Number).filter(Boolean);
    if (ids.length === 0) throw new Error(`${flag} requires at least one voucher id`);
    return ids;
}

function money(n: Prisma.Decimal | number | string | null | undefined): string {
    return Number(n ?? 0).toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    });
}

function assertPdfWorkerReady(needsRemint: boolean) {
    if (!COMMIT || !needsRemint) return;
    // dirname that has no sibling worker — forces the dist/ fallback check.
    const worker = resolveVoucherPdfWorkerFilename(path.join(process.cwd(), '__no_src_worker__'));
    if (worker && fs.existsSync(worker)) return;
    throw new Error(
        'PDF remint needs the compiled worker at dist/src/modules/voucher-pdf/voucher-pdf.worker.js.\n' +
            'Run `npm run build` first, then re-run with --commit.\n' +
            '(ts-node alone cannot import render-voucher-pdf.js from src/.)',
    );
}

type Candidate = {
    id: number;
    student_id: number;
    voucher_number: string | null;
    total_payable_before_due: Prisma.Decimal | null;
    total_payable_after_due: Prisma.Decimal | null;
    late_fee_deposited: Prisma.Decimal | null;
    paid_pdf_url: string | null;
    mode: 'totals' | 'remint-only';
};

async function main() {
    const idsFilter = parseIdsFlag('--ids');
    const remintIds = parseIdsFlag('--remint-ids');

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    const prisma = app.get(PrismaService);
    const vouchers = app.get(VouchersService);
    const auditLogs = app.get(AuditLogsService);

    const rows = await prisma.vouchers.findMany({
        where: {
            status: 'PAID',
            split_parent_id: { not: null },
            late_fee_deposited: { gt: 0 },
            ...(idsFilter ? { id: { in: idsFilter } } : {}),
        },
        select: {
            id: true,
            student_id: true,
            voucher_number: true,
            total_payable_before_due: true,
            total_payable_after_due: true,
            late_fee_deposited: true,
            paid_pdf_url: true,
        },
        orderBy: { id: 'asc' },
    });

    const candidates: Candidate[] = rows
        .filter((v) => {
            const before = new Prisma.Decimal(v.total_payable_before_due ?? 0);
            const after = new Prisma.Decimal(v.total_payable_after_due ?? 0);
            const deposited = new Prisma.Decimal(v.late_fee_deposited ?? 0);
            return !after.sub(before).eq(deposited);
        })
        .map((v) => ({ ...v, mode: 'totals' as const }));

    if (remintIds?.length) {
        const remintRows = await prisma.vouchers.findMany({
            where: {
                id: { in: remintIds },
                status: 'PAID',
                split_parent_id: { not: null },
            },
            select: {
                id: true,
                student_id: true,
                voucher_number: true,
                total_payable_before_due: true,
                total_payable_after_due: true,
                late_fee_deposited: true,
                paid_pdf_url: true,
            },
        });
        const byId = new Map(remintRows.map((r) => [r.id, r]));
        for (const id of remintIds) {
            const v = byId.get(id);
            if (!v) {
                console.log(`SKIP  remint-only #${id}: not a PAID split child`);
                continue;
            }
            if (v.paid_pdf_url) {
                console.log(`SKIP  remint-only #${id}: already has paid_pdf_url`);
                continue;
            }
            if (candidates.some((c) => c.id === id)) continue; // will remint via totals path
            candidates.push({ ...v, mode: 'remint-only' });
        }
    }

    if (idsFilter) {
        const found = new Set(rows.map((r) => r.id));
        const missing = idsFilter.filter((id) => !found.has(id));
        if (missing.length) {
            console.log(`NOTE  --ids not in candidate pool (not PAID split / no late_fee_deposited): ${missing.join(', ')}`);
        }
    }

    const needsRemint = candidates.some(
        (c) => c.mode === 'remint-only' || !!c.paid_pdf_url,
    );
    assertPdfWorkerReady(needsRemint);

    console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} — ${candidates.length} candidate(s)\n`);
    if (candidates.length === 0) {
        await app.close();
        return;
    }

    console.log(
        [
            'mode',
            'cc',
            'voucher_id',
            'voucher_number',
            'before_due',
            'after_due_old',
            'late_fee_deposited',
            'proposed_after_due',
            'paid_pdf',
        ].join('\t'),
    );

    const purge: string[] = [];
    let done = 0;
    let totalsOnly = 0;
    let reminted = 0;
    let failed = 0;

    for (const v of candidates) {
        const before = new Prisma.Decimal(v.total_payable_before_due ?? 0);
        const afterOld = new Prisma.Decimal(v.total_payable_after_due ?? 0);
        const deposited = new Prisma.Decimal(v.late_fee_deposited ?? 0);
        const afterNew = before.add(deposited);
        const hasPdf = !!v.paid_pdf_url;

        console.log(
            [
                v.mode,
                v.student_id,
                v.id,
                v.voucher_number ?? '',
                money(before),
                money(afterOld),
                money(deposited),
                money(afterNew),
                hasPdf ? 'yes' : v.mode === 'remint-only' ? 'orphan' : 'no',
            ].join('\t'),
        );

        if (!COMMIT) continue;

        try {
            if (v.mode === 'totals' && !afterOld.eq(afterNew)) {
                await prisma.vouchers.update({
                    where: { id: v.id },
                    data: { total_payable_after_due: afterNew } as any,
                });
                await auditLogs.log({
                    entity_type: 'VOUCHER',
                    entity_id: String(v.id),
                    action: 'UPDATED',
                    field: 'total_payable_after_due',
                    old_value: String(afterOld),
                    new_value: String(afterNew),
                    changed_by: CHANGED_BY,
                    student_id: v.student_id,
                    note:
                        `TAFSD-286: restored due-date late fee gap on PAID split child ` +
                        `(before ${before} + late_fee_deposited ${deposited}). Heads/deposits unchanged.`,
                });
            }

            if (v.mode === 'totals' && !hasPdf) {
                console.log(`      #${v.id}: totals fixed; no frozen receipt to remint`);
                totalsOnly++;
                done++;
                continue;
            }

            // Remint path: clear freeze (if any), render, re-freeze. Restore URL on failure.
            const previousUrl = v.paid_pdf_url;
            if (previousUrl) {
                await prisma.vouchers.updateMany({
                    where: { id: v.id, paid_pdf_url: previousUrl },
                    data: { paid_pdf_url: null, paid_pdf_filename: null, paid_pdf_generated_at: null },
                });
            }

            try {
                const minted = await vouchers.generatePdf(v.id);
                await auditLogs.log({
                    entity_type: 'VOUCHER',
                    entity_id: String(v.id),
                    action: 'UPDATED',
                    field: 'paid_pdf_url',
                    old_value: previousUrl,
                    new_value: minted.pdf_url ?? null,
                    changed_by: CHANGED_BY,
                    student_id: v.student_id,
                    note:
                        v.mode === 'remint-only'
                            ? `TAFSD-286: remint of PAID receipt left unlinked after a prior failed remint.`
                            : `TAFSD-286: one-off re-mint of write-once PAID receipt after correcting ` +
                              `total_payable_after_due (late-fee gap).`,
                });
                console.log(
                    `      #${v.id}: ${v.mode === 'totals' ? `${afterOld} -> ${afterNew}; ` : ''}` +
                        `remint -> ${minted.pdf_url}`,
                );
                if (minted.pdf_url) purge.push(new URL(minted.pdf_url).pathname.replace(/^\//, ''));
                reminted++;
                done++;
            } catch (err) {
                if (previousUrl) {
                    await prisma.vouchers.update({
                        where: { id: v.id },
                        data: {
                            paid_pdf_url: previousUrl,
                            // filename/generated_at unknown after clear — URL alone
                            // is enough for generatePdf's freeze short-circuit / download.
                        } as any,
                    });
                    console.error(
                        `      #${v.id}: remint FAILED — restored previous paid_pdf_url. ${err}`,
                    );
                } else {
                    console.error(
                        `      #${v.id}: remint FAILED (no prior URL to restore). ${err}`,
                    );
                }
                failed++;
            }
        } catch (err) {
            console.error(`      #${v.id}: FAILED. ${err}`);
            failed++;
        }
    }

    if (!COMMIT) {
        console.log(
            `\nwould repair: ${candidates.length} (finance: review table above; then npm run build && --commit)`,
        );
    } else {
        console.log(
            `\nrepaired: ${done}; totals-only: ${totalsOnly}; reminted: ${reminted}; failed: ${failed}`,
        );
    }
    if (purge.length) console.log(`\nPurge from the CDN:\n${purge.join('\n')}`);
    await app.close();
    if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
