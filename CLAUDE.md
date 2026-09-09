# Finance rules — check after every finance-related change

Scope: anything touching **vouchers, student_fees, deposits, discounts,
scholarships, arrears/surcharges, waivers, the Fee Heads / Defaulters / Deposits
financial reports, analytics finance tiles, or the challan PDF.**

General (non-finance) backend conventions live in `CODING_PRACTICES.md`.
Voucher-issuance code duplication is documented in
`src/modules/vouchers/CLAUDE.md` — read it too before touching `create()` /
`splitPartiallyPaid()`.

---

## Post-run checklist

Run this after any change in scope above. Each item is a hard invariant — if a
change makes one false, the change is wrong, not the rule.

1. **Reconciliation** — Fee Heads report still reconciles:
   `billed + to_be_billed + waived === amount` and
   `amount_paid + outstanding + waived === amount`
   (`financial-reports.service.ts` `buildTotalsCheck`). No amber banner on a
   normal range. `npm test -- financial-reports` (snapshot + reconcile specs).
2. **Arrears definition** — arrears still come only from
   `VouchersService.computeArrears` (`vouchers.service.ts`). It excludes
   `status IN (PAID, DISCOUNT, WAIVED)` and `is_arrear_surcharge` /
   `is_discount` rows. The two legacy definitions (`students.service.ts`,
   `analytics.service.ts` `due_date < today`) are known-wrong and must not be
   reintroduced as the source of truth. `npm run -s ts-node scripts/verify-defaulters-vs-compute-arrears.ts`.
3. **Void-predecessor reactivation** — see Rule A below. Run
   `npm test -- supersede-by-fee-date` and
   `scripts/verify-split-deposit-reversal.ts`.
4. **Descending-order deletes** — a voucher / deposit can only be
   deleted/reversed if it is the most recent for that student
   (`assertDepositIsLatest`, `remove()` latest check). Newer ones first.
5. **`student_fees.amount` is the single source of truth** for receivables,
   forced whole-number by `trg_student_fees_amount_invariants`. Never derive a
   receivable from `amount_before_discount` / `amount_after_discount` except as
   the documented fallback `amount ?? amount_before_discount ?? 0`.
6. **Discounts** are separate negative `student_fees` rows
   (`is_discount = true`, `status = DISCOUNT`, `amount_paid = 0`). Every money
   roll-up queries them separately and subtracts. A discount head's
   `voucher_heads.balance` is hardcoded 0 and can never be deposited against.
7. **Deposit reversal recomputes, never zeroes** — `reverseDeposit` /
   `clearDeposit` re-derive `student_fees.amount_paid`,
   `voucher_arrear_surcharges.amount_paid` and each voucher's heads/status from
   the allocations that survive. A reversed head keeps any *other* payment.
8. **PAID PDF is write-once** — `vouchers.paid_pdf_url` / `paid_pdf_filename`
   are minted lazily and never re-rendered; only a genuine payment reversal
   (`clearDeposit`) clears them.
9. **Waiver** (`project_fee_head_voucher_waiver`) — a `WAIVED` head/voucher is a
   permanent write-off: excluded from arrears, deposits rejected, never
   re-billed (`create()` rejects a waived id in `orderedFeeIds`; supersession
   never scans/absorbs a waived voucher). `normalizeVoucher` treats `WAIVED` as
   terminal like `VOID/PAID/EXPIRED`. Un-waive is the only way back.
10. **Bulk issuance shares `create()`** — single + bulk both call
    `VouchersService.create()`; `splitPartiallyPaid()` is a hand-maintained
    duplicate. Any issuance-behaviour change lands in both.
11. `npx tsc --noEmit -p tsconfig.build.json` is clean.

---

## Rule A — deleting a superseding voucher MUST reactivate its predecessors

**Invariant.** When voucher issuance supersedes older vouchers
(`_planFeeDateSupersession`: blunt "void every not-fully-paid voucher with
`fee_date <= new`"), deleting that superseding voucher (most-recent-first) MUST
bring every one of those predecessors back — `OVERDUE` if `due_date` has passed,
else `UNPAID` — via `_destroyVoucherInTx` STEP 1 + STEP 7.

**Mechanism (fixed 2026-09-09).** `create()` step 6 stamps each voided
predecessor with `vouchers.superseded_by_voucher_id = <new voucher id>`.
`_destroyVoucherInTx` STEP 1 reactivates **exactly** the `status = 'VOID'`
vouchers whose `superseded_by_voucher_id` equals the voucher being deleted;
STEP 7 flips them to `OVERDUE`/`UNPAID` and clears the link. Already-`VOID`
predecessors are never re-stamped, so a chain V1→V2→V3 keeps V1 pointing at V2
and only V2 reactivates when V3 is deleted.

**Why the old code broke:** STEP 1 used to guess from head-set containment
("every head of the VOID candidate is among the deleted voucher's heads"). But
`_planFeeDateSupersession` only absorbs a predecessor's **outstanding,
non-discount, non-paid** heads onto the new voucher — so any predecessor
carrying a discount head or an already-paid head never satisfied containment and
silently stayed `VOID` forever, its balance vanishing from every report. The
containment heuristic is still run as a **fallback** for vouchers voided before
`superseded_by_voucher_id` existed; do not remove it.

**When touching supersession, `create()` head selection, split, or
`_destroyVoucherInTx`, verify:**

1. Issue V1 (fee_date D1). Issue V2 (fee_date D2 > D1) — V1 → `VOID`, its unpaid
   heads absorbed onto V2. Delete V2 → **V1 back to `UNPAID`/`OVERDUE`**, its
   heads re-linked, no duplicate active voucher.
2. Same but V1 is `PARTIALLY_PAID` before V2 is issued. Delete V2 → V1
   reactivates as `PARTIALLY_PAID` with its recorded deposits intact; the
   remainder is owed on V1 again, not orphaned.
3. Chain V1→V2→V3 (each fully absorbing the previous). Delete V3 → only V2
   reactivates; V1 stays `VOID` (V2 still carries its heads as arrears).
4. `supersede-by-fee-date.spec.ts` (incl. the `_destroyVoucherInTx` reactivation
   test) and any split reversal spec still green.

The link is authoritative. Never "fix" a reactivation miss by widening the
fallback containment heuristic — fix why the link wasn't written.

---

## Rule B — the latest voucher has a Regenerate button; issuance inputs come from one shared form

**Invariant.** A student's **most recent** voucher (any status;
`is_latest_for_student`) must expose a **Regenerate** action. Regenerate must
collect the **same inputs as single issuance on `/fee-challan`**, through **one
reusable form component** — not a second inline copy of the fields.

**The shared issuance-form component** must gather (superset of
`CreateVoucherDto` / `SplitPartiallyPaidDto` / `StartBulkJobDto`):

- period / `month`, `issue_date`, `due_date`, `validity_date`, `fee_date`
  (or `fee_date_from` / `fee_date_to` range for bulk)
- bank: `bank_account_id` + editable account title / number / branch code /
  address / IBAN
- `late_fee_charge` (+ `late_fee_amount`)
- `reprint_fee_charge` (+ `reprint_fee_amount`)
- `waive_surcharge` (+ `waived_by`)
- `send_notification`
- `requires_release` / `hold_for_release`

**Must consume this one component (no divergent copies):**

1. `/fee-challan` — single issuance.
2. Bulk generate (`bulk-voucher-jobs` start form).
3. Vouchers page — **split** a voucher.
4. Vouchers **deposit** page — **split** a voucher.
5. Vouchers page — **regenerate** the latest voucher.

**Check after any issuance-form change:** all five entry points render the same
fields, defaults, and validation; a field added for one appears in all five;
regenerate on the latest voucher reissues with the chosen inputs and the old
voucher is superseded/replaced per Rule A (so its predecessors still reactivate
if the regenerated one is later deleted).

---

## Status vocabularies (do not invent new values silently)

- `vouchers.status` (free-form VARCHAR): `UNPAID`, `OVERDUE`, `EXPIRED`,
  `PARTIALLY_PAID`, `PAID`, `VOID`, `WAIVED`.
- `fee_status_enum` (`student_fees.status`): `NOT_ISSUED`, `ISSUED`,
  `PARTIALLY_PAID`, `PAID`, `DISCOUNT`, `WAIVED`.
- `deposit_allocations.type`: `FEE_HEAD`, `LATE_FEE`, `SURCHARGE`, `DISCOUNT`.

Adding a value means auditing every `status IN (...)` / `notIn` / switch in
`vouchers.service.ts`, `financial-reports.service.ts`, `analytics.service.ts`,
`students.service.ts`, `bulk-voucher-logic.service.ts`, the schedulers, and the
webapp status filters/badges.
