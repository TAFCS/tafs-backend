/**
 * TAFSD-511 audit (read-only). Lists fee heads that sit on more than one
 * voucher that still counts: a live one (UNPAID / OVERDUE / EXPIRED /
 * PARTIALLY_PAID) beside any other non-VOID voucher (live or PAID).
 *
 * A head should have one live bill at a time. Two happened when an earlier
 * fee-date voucher was issued after a later one (supersession only voids
 * vouchers on or before the new fee date). Since TAFSD-511 create() and the
 * split refuse that, so anything listed here predates the fix.
 *
 * For each pair it says whether the head is already paid. A live voucher
 * whose shared heads are all paid elsewhere is a stale bill (CC 8144's
 * #14238): the school decides, and it is removed with force-delete, which
 * since TAFSD-511 leaves heads paid through another voucher alone.
 *
 * Run: npx ts-node scripts/audit-shared-live-heads.ts
 * Writes nothing. Reads whatever DATABASE_URL points at.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const LIVE = ['UNPAID', 'OVERDUE', 'EXPIRED', 'PARTIALLY_PAID'];

async function main() {
  const rows = await prisma.$queryRaw<
    Array<{
      student_id: number;
      student_fee_id: number;
      fee_status: string;
      live_id: number;
      live_status: string;
      live_fee_date: Date | null;
      other_id: number;
      other_status: string;
      other_fee_date: Date | null;
    }>
  >`
    SELECT v1.student_id, h1.student_fee_id, sf.status::text AS fee_status,
           v1.id AS live_id, v1.status AS live_status, v1.fee_date AS live_fee_date,
           v2.id AS other_id, v2.status AS other_status, v2.fee_date AS other_fee_date
      FROM voucher_heads h1
      JOIN vouchers v1 ON v1.id = h1.voucher_id
      JOIN voucher_heads h2 ON h2.student_fee_id = h1.student_fee_id AND h2.voucher_id <> h1.voucher_id
      JOIN vouchers v2 ON v2.id = h2.voucher_id
      JOIN student_fees sf ON sf.id = h1.student_fee_id
     WHERE v1.status = ANY(${LIVE})
       AND v2.status <> 'VOID'
       AND NOT (v2.status = ANY(${LIVE}) AND v2.id < v1.id)
       AND sf.is_discount = false
     ORDER BY v1.student_id, v1.id, v2.id, h1.student_fee_id`;

  if (!rows.length) {
    console.log('No fee head is on two counting vouchers.');
    return;
  }

  const byPair = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.live_id}:${r.other_id}`;
    byPair.set(k, [...(byPair.get(k) ?? []), r]);
  }
  const day = (d: Date | null) =>
    d ? new Date(d).toISOString().slice(0, 10) : '-';
  console.log(`${byPair.size} voucher pair(s) share heads:\n`);
  for (const pair of byPair.values()) {
    const r = pair[0];
    const paid = pair.filter((p) => p.fee_status === 'PAID').length;
    console.log(
      `CC ${r.student_id}: #${r.live_id} ${r.live_status} (fee date ${day(r.live_fee_date)})` +
        ` and #${r.other_id} ${r.other_status} (fee date ${day(r.other_fee_date)})` +
        ` share ${pair.length} head(s), ${paid} paid: ${pair.map((p) => p.student_fee_id).join(', ')}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
