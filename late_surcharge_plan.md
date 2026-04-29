Read the schema first.Good. Full picture. Here's the complete work guide.

---

## The Core Problem Being Solved

Right now surcharge rows live permanently in `student_fees`. This means:
- They pollute the fee schedule forever
- They carry over incorrectly when vouchers are regenerated
- When an old voucher is voided and a new one is generated, the new voucher re-reads those `student_fees` surcharge rows and double-counts
- They show up on the student-wise fees page as permanent heads which they shouldn't be

The fix: surcharges are **ephemeral, voucher-scoped data**. They exist only in the context of a specific voucher. When that voucher is voided, the surcharge goes with it. `student_fees` never stores a surcharge row again.

---

## Schema Changes

### 1. New table — `voucher_arrear_surcharges`

This replaces all surcharge rows that were previously written to `student_fees`. One row per arrear month group per voucher.

```prisma
model voucher_arrear_surcharges {
  id               Int      @id @default(autoincrement())
  voucher_id       Int
  arrear_fee_date  DateTime @db.Date      // the fee_date of the arrear month this charge is for
  arrear_month     Int                    // target_month of the arrear (e.g. 8 for August)
  arrear_year      String   @db.VarChar(10) // academic_year of the arrear
  amount           Decimal  @db.Decimal(12, 2) // always 1000 per row, but stored explicitly
  waived           Boolean  @default(false)
  waived_by        String?  @db.VarChar(255)
  vouchers         vouchers @relation(fields: [voucher_id], references: [id], onDelete: Cascade)

  @@index([voucher_id])
}
```

`onDelete: Cascade` means when a voucher is voided/deleted, all its surcharge rows vanish automatically. No orphan cleanup needed.

### 2. Remove columns from `vouchers`

`total_arrear_surcharge` and `surcharge_waived` and `surcharge_waived_by` are now derivable from `voucher_arrear_surcharges`. Remove them from `vouchers` to avoid duplication. The total surcharge on a voucher is simply `SUM(amount) WHERE waived = false` from the surcharges table.

Keep `surcharge_waived` as a convenience boolean on `vouchers` only if you need a quick filter — but if you do keep it, it must always be derived and updated from the surcharges table, never set independently.

### 3. Migrate existing `student_fees` surcharge rows

Before deploying, run a migration script:

```sql
-- Find all student_fees rows that are arrear surcharges
-- (is_arrear_surcharge = true)
-- For each one, find which voucher it was attached to via voucher_heads
-- Insert a corresponding voucher_arrear_surcharges row
-- Then delete the student_fees rows

INSERT INTO voucher_arrear_surcharges (voucher_id, arrear_fee_date, arrear_month, arrear_year, amount, waived)
SELECT 
  vh.voucher_id,
  sf.fee_date,
  sf.target_month,
  sf.academic_year,
  sf.amount,
  false
FROM student_fees sf
JOIN voucher_heads vh ON vh.student_fee_id = sf.id
WHERE sf.is_arrear_surcharge = true;

-- Then delete the voucher_heads rows pointing to those surcharge fees
DELETE FROM voucher_heads WHERE student_fee_id IN (
  SELECT id FROM student_fees WHERE is_arrear_surcharge = true
);

-- Then delete the student_fees surcharge rows
DELETE FROM student_fees WHERE is_arrear_surcharge = true;
```

Run this in a transaction. Verify counts before committing.

### 4. `is_arrear_surcharge` on `student_fees`

Once migration is done and the new system is in place, this column is obsolete. Leave it in the schema for now (don't drop mid-sprint), but nothing should ever write `true` to it again. Add a comment in code: `// DEPRECATED — surcharges now stored in voucher_arrear_surcharges`.

---

## Backend Changes

### Voucher generation service — `computeArrears`

Remove all logic that creates `student_fees` rows with `is_arrear_surcharge = true`. Replace with the new flow:

```typescript
// After identifying arrear fee groups...

const arrearFeeGroups = groupBy(arrearHeads, 'fee_date'); 
// groups arrear heads by their fee_date — each unique fee_date = one surcharge

const surcharges = Object.entries(arrearFeeGroups).map(([feeDate, heads]) => ({
  arrear_fee_date: new Date(feeDate),
  arrear_month: heads[0].target_month,
  arrear_year: heads[0].academic_year,
  amount: 1000,        // PKR 1000 per arrear fee_date group
  waived: waiveSurcharge  // boolean passed from the generation request
}));

// These are NOT inserted yet — they go into the voucher creation transaction
```

### Voucher creation transaction

When creating the voucher, include the surcharges in the same transaction:

```typescript
const voucher = await prisma.$transaction(async (tx) => {
  // 1. Create the voucher record
  const v = await tx.vouchers.create({ data: { ...voucherData } });

  // 2. Create voucher_heads for current + arrear fee heads (no surcharge rows here)
  await tx.voucher_heads.createMany({ data: headRows.map(h => ({ ...h, voucher_id: v.id })) });

  // 3. Create surcharge rows — ephemeral, voucher-scoped
  if (surcharges.length > 0) {
    await tx.voucher_arrear_surcharges.createMany({
      data: surcharges.map(s => ({ ...s, voucher_id: v.id }))
    });
  }

  // 4. Update voucher total to include non-waived surcharges
  const surchargeTotal = surcharges
    .filter(s => !s.waived)
    .reduce((sum, s) => sum + Number(s.amount), 0);

  await tx.vouchers.update({
    where: { id: v.id },
    data: {
      total_arrear_surcharge: surchargeTotal,
      total_payable_before_due: { increment: surchargeTotal }
    }
  });

  return v;
});
```

### Waiver logic on single voucher generation

The fee challan page (single voucher generation) already has a "waive surcharge" toggle. Wire it through:

```typescript
// In the generation request DTO
waive_surcharge: boolean  // false by default

// When waive_surcharge = true:
// All surcharge rows created with waived = true, waived_by = current user id
// total_arrear_surcharge = 0
// total_payable does not include surcharge
// PDF shows "Late payment surcharge of PKR X,000 — WAIVED" in the totals section
```

### Waiver logic on bulk generation

`bulk_voucher_jobs` already has `waive_surcharge: Boolean`. The bulk processor reads this and passes it to the voucher generation logic for every student in the job. Same flow as single generation.

### Voucher void/regeneration

When a voucher is voided and regenerated for the same student + fee_date range, the old voucher is deleted (or status set to VOID). Because `voucher_arrear_surcharges` has `onDelete: Cascade`, all surcharge rows from the old voucher are automatically removed. The new voucher generation runs `computeArrears` fresh — it knows nothing about what surcharges the old voucher had, and that is correct behaviour. It simply re-evaluates unpaid arrears at generation time and creates new surcharge rows.

This is the key correctness guarantee of this design. The new voucher is never "aware" of the old voucher's surcharges — it only looks at `student_fees.amount_paid` vs `student_fees.amount` to determine what's unpaid, then calculates surcharges from scratch.

### Fetching a voucher for display (deposits page, vouchers page)

Update all voucher fetch queries to include `voucher_arrear_surcharges`:

```typescript
const voucher = await prisma.vouchers.findUnique({
  where: { id },
  include: {
    voucher_heads: {
      include: { student_fees: { include: { fee_types: true } } }
    },
    voucher_arrear_surcharges: true  // add this
  }
});

// Compute total surcharge for display
const activeSurchargeTotal = voucher.voucher_arrear_surcharges
  .filter(s => !s.waived)
  .reduce((sum, s) => sum + Number(s.amount), 0);
```

---

## PDF Challan Changes

### Main three columns (bank copy / school copy / student copy)

The arrears + surcharge section of the three main columns now looks like this — strictly two rows, no more itemised months:

```
Arrears (Aug–Sep 2025)          PKR 27,950
Late Payment Surcharge          PKR 2,000
```

The arrears row label is dynamically built from the months present: take all `voucher_heads` where `student_fees.fee_date < voucher.fee_date` and `is_arrear_surcharge = false`, extract their `target_month` values, sort them, render as "Aug–Sep 2025" or "Aug, Oct 2025" etc. The amount is `vouchers.total_arrears`.

The late payment surcharge row label is always static: "Late Payment Surcharge". The amount is `SUM(amount) WHERE waived = false` from `voucher_arrear_surcharges`. If all surcharges are waived, this row shows "Late Payment Surcharge — WAIVED" with the original amount struck through and amount shown as PKR 0 or omitted entirely.

If there are no arrears at all (brand new student, first voucher of the year), neither row appears.

### Fourth column (arrear history sidebar)

Contains only the actual arrear fee heads — each `voucher_head` where `student_fees.fee_date < voucher.fee_date` and `is_arrear_surcharge = false`. Shows month, description, outstanding amount. No surcharge rows here at all. The surcharge is a billing line on the main columns, not a fee head that needs a history breakdown.

---

## Student-wise Fees Page

No surcharge rows will ever appear here again. The page reads `student_fees` — since surcharges no longer live there, they simply won't show up. Nothing to change on this page except removing any code that previously filtered out or handled `is_arrear_surcharge = true` rows — that filter can be removed as dead code once the migration is done.

---

## Summary of what changes where

**Deleted behaviour:** writing `student_fees` rows with `is_arrear_surcharge = true` anywhere in the codebase. Find every instance of this and remove it.

**New behaviour:** after arrear computation, create `voucher_arrear_surcharges` rows inside the voucher creation transaction.

**New schema:** `voucher_arrear_surcharges` table as specified above.

**Migration:** one-time script to move existing surcharge rows from `student_fees` → `voucher_arrear_surcharges` and clean up `voucher_heads` references.

**PDF:** two consolidated rows in main columns (arrears total + surcharge total). Fourth column shows only real arrear heads.

**Waiver:** stored per surcharge row (`waived`, `waived_by`), reflected in `vouchers.total_arrear_surcharge` on save.