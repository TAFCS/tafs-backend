# Voucher issuance: shared vs. duplicated code

## IMPORTANT — the three primary sources of unpaid vouchers

**Every unpaid voucher in this system is born in exactly one of three places. There are no
others. All three must stay in sync: a voucher issued from any of them must come out
indistinguishable from one issued by the other two, given the same inputs.**

| # | Where a user does it | Code path | Shares `create()`? |
|---|---|---|---|
| **1** | **`/fee-challan` page** — single issuance | `VouchersController.create()` → **`VouchersService.create()`** | ✅ yes |
| **2** | **Bulk voucher page** — bulk job | `BulkVoucherJobsService.processWorkItem()` → **`VouchersService.create()`** (per student, `bulkVoucherJobId` threaded through) | ✅ yes |
| **3** | **Split** — generating a new balance voucher | **`VouchersService.splitPartiallyPaid()`** | ❌ **no — hand-maintained duplicate** |

**(1) and (2) share real code.** Any change to `VouchersService.create()` automatically applies to
both single and bulk issuance. Bulk needs no separate edit.

**(3) does NOT call `create()`.** It runs its own `tx.vouchers.create()` calls and hand-mirrors
`create()`'s field-setting conventions — you'll find comments throughout `splitPartiallyPaid()`
like "mirrors create()" and "mirror the single-issuance form" that say so explicitly. This is a
known, accepted duplication, not an oversight.

### The rule this file exists to state

**Any change to voucher-issuance behavior — new fields, watermarks, due/validity date policy,
status defaults, head selection, arrears/supersession handling, anything that affects what a
newly-created voucher row looks like — must be made in both `VouchersService.create()` and
`VouchersService.splitPartiallyPaid()`.** They do not share code, only shared conventions
enforced by comments and human discipline.

### Sync checklist — run all three after any issuance change

1. Issue a single voucher from `/fee-challan`.
2. Issue the same student through a bulk job.
3. Split a `PARTIALLY_PAID` voucher and inspect the new balance voucher.

Compare the three resulting rows: same status defaults, same date policy, same head set and
ordering, same totals, same watermark flags, same PDF columns written. A field that appears on
one and not the others is a bug in this rule, not a feature of that flow.

A pre-existing, unrelated example of what happens when this isn't done: the `due_date`/
`validity_date` *default* (when the user hasn't typed one in) is computed three different, non-
shared ways across the frontend — `+10/+15 days` in the single-issuance form, no default in the
bulk job config, and "inherit from original" in the split settings panel. That drift already
exists; this task didn't need to fix it, just don't add to the pile.

## Worked example: PAY IMMEDIATELY

When a student already has arrears spanning 2+ distinct billing months (tracked via
`computeArrears()`'s `surcharge_groups`, one entry per distinct `(academic_year, target_month)`
arrear group) at the moment a new voucher is issued, that voucher gets:

- `due_date` and `validity_date` forced to `issue_date + PAY_IMMEDIATE_DUE_DAYS` (4 days),
  overriding whatever the caller/UI sent.
- `vouchers.pay_immediately = true`, persisted once at creation (not recomputed on reprint).
- A diagonal red "PAY IMMEDIATELY" watermark on the PDF (see `FeeChallanPDF.tsx` /
  `FeeChallanPDF_MeezanBank.tsx`, mirroring the existing green `PAID` watermark pattern), shown
  whenever `pay_immediately` is true and the voucher isn't fully `PAID`.

Both constants (`PAY_IMMEDIATE_ARREAR_MONTHS_THRESHOLD`, `PAY_IMMEDIATE_DUE_DAYS`) live near the
top of `vouchers.service.ts`, above `PDF_FREEZE_SELECT`.

**Frontend enabler.** The whole feature is gated behind `app_config.pay_immediately_enabled`
(checked via `VouchersService.isPayImmediateEnabled()`, generic `app_config` key-value store —
see `../app-config/app-config.service.ts`), seeded `'false'`. It ships dormant: merging this code
doesn't change voucher behavior until a SUPER_ADMIN flips the toggle on `/admin/developer`
(webapp) or `PATCH /v1/app-config/pay_immediately_enabled`. Once confirmed in production, that
default can be reconsidered — but don't remove the check itself, since it's the one on/off switch
for both `create()` and `splitPartiallyPaid()`.

This was implemented independently in both places, per the rule above:

- `create()`: right after `surchargeGroups` is computed from `computeArrears()`, before the
  arrear fee ids are merged into `finalOrderedFeeIds`.
- `splitPartiallyPaid()`: right after `targetFeeDate` is derived, via a **read-only** call to
  `computeArrears()` (it does not touch `student_fees` or persisted surcharges — that would
  violate the split's separate "never recompute or drop arrear surcharges" invariant). Applied
  only to the **balance/unpaid** voucher — the paid receipt keeps the original voucher's dates and
  is never eligible.

If you're adding the next cross-cutting voucher-issuance feature, search both functions for
`PAY_IMMEDIATE` first — it's the template to follow.

## Worked example: WAIVED heads at issuance

The fee waiver (`project_fee_head_voucher_waiver`, and **Rule C** in the finance `CLAUDE.md`)
changed what issuance does with a head whose `student_fees.status` is already `WAIVED`. This is
the second template to follow, and it touched the three sources above as follows.

**`create()` — so sources (1) `/fee-challan` and (2) bulk both got it:**

- It used to **reject** the whole request if any id in `orderedFeeIds` was `WAIVED`. It no longer
  does. A waived head now rides on the voucher as a **zero-balance display head**
  (`voucher_heads.waived = true`), so the challan can print it as a green `WAIVED` credit line.
  It is never added to `total_payable_before_due` / `total_payable_after_due` / `total_arrears`,
  and step 4 leaves its `student_fees.status` at `WAIVED` instead of demoting it to `ISSUED`.
- **`issueAsWaived`**: when *every* non-discount head in the payload is already `WAIVED`, the new
  voucher is itself issued as a write-off — `status = 'WAIVED'`, both payable totals forced to 0,
  `waived_at` / `waived_by` / `surcharge_waived` set, and the PDF carries the diagonal `WAIVED`
  watermark.
- **`issueAsWaived` skips `computeArrears()` and `_planFeeDateSupersession()`.** This is the
  subtle one: without the skip, issuing a fully-waived challan would void a real, unpaid
  predecessor voucher by fee-date (Rule A) — a write-off would silently erase money the family
  still owes.
- `_destroyVoucherInTx` STEP 6 excludes waived heads from the `NOT_ISSUED` reset, so deleting the
  voucher leaves them `WAIVED`.

**`splitPartiallyPaid()` — source (3):** a `PARTIALLY_PAID` voucher must never carry a waived head
(a head with any payment cannot be waived, and waiving any head waives the whole voucher, which is
rejected as un-splittable). The head loop therefore **throws** on `sf.status === 'WAIVED'` rather
than silently dropping the head from both output vouchers. That is the deliberate sync decision:
sources (1) and (2) *accept* waived heads, source (3) *rejects* them, because a waived head can
only legally reach source (3) if the voucher family is already corrupt.

**PDF side (shared by all three):** `prepareVoucherPdfData` emits waived heads with
`isWaived` / `waivedAmount`, keeps them out of month-range consolidation and out of the arrears
history, and no longer lists a waived installment as a "missed arrear".
