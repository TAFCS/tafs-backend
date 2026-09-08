# Voucher issuance: shared vs. duplicated code

Fee vouchers get created three ways. Two of them genuinely share one function; the third is a
separately hand-maintained duplicate. Get this wrong and behavior drifts silently between flows.

## The three entry points

1. **Single issuance** — `VouchersController.create()` (`vouchers.controller.ts`) →
   `VouchersService.create()` (`vouchers.service.ts:363-868`, exact lines shift as the file
   changes).
2. **Bulk issuance** — `BulkVoucherJobsService.processWorkItem()`
   (`../bulk-voucher-jobs/bulk-voucher-jobs.service.ts`) → **also calls**
   `VouchersService.create()`, per student, with `bulkVoucherJobId` threaded through.
3. **Post-split issuance** — `VouchersService.splitPartiallyPaid()` (`vouchers.service.ts`,
   starting ~line 4281). Splits a `PARTIALLY_PAID` voucher into a `PAID` receipt voucher and an
   `UNPAID` balance voucher.

**(1) and (2) share real code: `VouchersService.create()`.** Any change made there automatically
applies to both single and bulk issuance.

**(3) does NOT call `create()`.** It runs its own `tx.vouchers.create()` calls and hand-mirrors
`create()`'s field-setting conventions — you'll find comments throughout `splitPartiallyPaid()`
like "mirrors create()" and "mirror the single-issuance form" that say so explicitly. This is a
known, accepted duplication, not an oversight.

## The rule this file exists to state

**Any change to voucher-issuance behavior — new fields, watermarks, due/validity date policy,
status defaults, anything that affects what a newly-created voucher row looks like — must be made
in both `VouchersService.create()` and `VouchersService.splitPartiallyPaid()`.** They do not share
code, only shared conventions enforced by comments and human discipline. Bulk issuance needs no
separate edit since it calls `create()`.

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
