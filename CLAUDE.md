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
   reintroduced as the source of truth. `npx ts-node scripts/verify-defaulters-vs-compute-arrears.ts` (read-only, but it
   reads the **live** DB, so its six pinned students drift as vouchers get paid /
   regenerated — hand-verify a 7291/7402/7403/7720 mismatch before calling it a
   regression; 7570 and 7670 are the load-bearing ones).
3. **Void-predecessor reactivation** — see Rule A below. Run
   `npm test -- supersede-by-fee-date` (pure unit specs, always safe). The
   end-to-end script is `VERIFY_SPLIT_REVERSAL=1 npm run verify:split-reversal`
   — it **creates and deletes** voucher/fee/deposit rows (tagged
   `academic_year='VERIFYX'`, torn down in a `finally`), so run it against a
   dev/test DB only, never the shared remote one.
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
   **Paid is cash only.** When a discount settles a head it is written into
   that head's `amount_paid` and into the discount row's own `amount_paid`
   (as consumed), so any "paid" roll-up must be heads' `amount_paid` **minus**
   discount rows' `amount_paid` (`FinancialReportsService.netPaid`). Summing
   heads alone counts the discount as money: a 100,000 voucher with a 20,000
   discount paid with 80,000 reported 100,000 paid, −20,000 outstanding.
   `npm test -- fee-heads-discount`.
7. **Deposit reversal recomputes, never zeroes** — `reverseDeposit` /
   `clearDeposit` re-derive `student_fees.amount_paid`,
   `voucher_arrear_surcharges.amount_paid` and each voucher's heads/status from
   the allocations that survive. A reversed head keeps any *other* payment.
8. **Stamped PDFs are write-once** — `paid_pdf_url` / `paid_pdf_filename` and
   `waived_pdf_url` / `waived_pdf_filename` are minted once and never
   re-rendered. Only the matching reversal clears them: `clearDeposit` /
   `reverseDeposit` for the PAID receipt, `unwaiveVoucher` for the WAIVED
   challan. See **Rule C**.
9. **Waiver** (`project_fee_head_voucher_waiver`) — a `WAIVED` head/voucher is a
   permanent write-off: excluded from arrears, deposits rejected, never
   re-billed (`create()` issues a fully-waived challan as a WAIVED voucher
   rather than billing it; supersession never scans/absorbs a waived voucher).
   `normalizeVoucher` treats a `WAIVED` *voucher* as terminal like
   `VOID/PAID/EXPIRED`, and drops a waived *head* from a mixed voucher's totals
   the way it drops discount rows. Un-waive is the only way back. See **Rule C**
   for the lifecycle and **Rule D** for how the two waiver shapes present.
10. **Bulk issuance shares `create()`** — single + bulk both call
    `VouchersService.create()`; `splitPartiallyPaid()` is a hand-maintained
    duplicate. Any issuance-behaviour change lands in both. **PAY IMMEDIATELY**
    must stay identical across single, bulk and the split balance voucher and
    obey the `pay_immediately_enabled` toggle — rules and checks in
    `src/modules/vouchers/CLAUDE.md`; `npm test -- pay-immediately`.
11. **Schema reads must not outrun the migration** — the datasource is the
    shared remote DB and `prisma migrate deploy` is run deliberately, so a
    column added to `schema.prisma` does NOT exist yet. Never add a new column
    to a hot `select` (especially `PDF_FREEZE_SELECT`, `VOUCHER_INCLUDE`,
    `PDF_FREEZE_SELECT`'s callers `generatePdf` / `loadFreezeRows`) in the same
    commit that introduces it — Prisma fails the whole query with `P2022` and
    takes down *every* voucher, not just the new feature's. Either apply the
    migration first, or read the column defensively until it lands.
    `npx prisma migrate status` must say "Database schema is up to date!"
    before shipping code that reads new columns.
12. `npx tsc --noEmit -p tsconfig.build.json` is clean.

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

**Which deletions reactivate (fixed 2026-09-18).** `remove()` passes
`reactivate = voucher.status !== 'VOID'`. `UNPAID` / `OVERDUE` / `EXPIRED`
deletions all reactivate. `VOID` is the **only** status that must not: something
newer is still standing in its place, and that successor owns the predecessors
(the V1→V2→V3 chain above), so reactivating them would double-bill the same
heads.

**Never re-add `EXPIRED` to that exclusion.** `EXPIRED` is a *live* voucher whose
validity window merely closed — `vouchers-scheduler.service.ts` promotes
`UNPAID`/`OVERDUE` → `EXPIRED` on `validity_date`, and such a voucher never
superseded anything. It was lumped in with `VOID` between `7b6dda5` (a sweep that
added "and EXPIRED" beside `VOID` in ~8 places, correct in all but this one) and
2026-09-18, and the result was silent and **irreversible**: deleting an expired
voucher stranded its predecessor as `VOID` forever. `superseded_by_voucher_id` is
a bare `Int?` with an index and **no FK** (`schema.prisma`), so the stranded row
kept pointing at the deleted voucher, and STEP 1 only ever searches by the id
being deleted — no later delete could find it again. Meanwhile STEP 6/7b still
reset that voucher's heads to `NOT_ISSUED`, leaving a `VOID` voucher holding
unbilled heads. Guarded by the `remove() — which deletions reactivate the
superseded predecessor` tests in `supersede-by-fee-date.spec.ts`.

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
4. Issue V1, issue V2 (V1 → `VOID`), then let V2 reach `EXPIRED` — either wait
   for the validity-date cron or set the status by hand. Delete V2 → **V1 still
   comes back**. An expired voucher deletes exactly like an overdue one.
5. `supersede-by-fee-date.spec.ts` (incl. the `_destroyVoucherInTx` reactivation
   test and the `remove()` status-gate tests) and any split reversal spec still
   green.

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

## Rule C — WAIVED is the write-off mirror of PAID, and must behave identically

**Invariant.** `ISSUED → WAIVED → ISSUED` must work exactly the way
`ISSUED → PAID → ISSUED` already works. Every mechanism that exists for a
payment has a waiver counterpart, and the two must stay in step. If you change
one column of the table below, change the other.

| | Payment | Waiver |
|---|---|---|
| Enters the terminal state | `recordDeposit()` — all heads settled | `waiveVoucher()` — all heads written off |
| `vouchers.status` | `PAID` | `WAIVED` |
| `student_fees.status` | `PAID` | `WAIVED` |
| Stamped artifact | `paid_pdf_url` / `paid_pdf_filename` / `paid_pdf_generated_at` | `waived_pdf_url` / `waived_pdf_filename` / `waived_pdf_generated_at` |
| Storage key suffix | `_paid.pdf` | `_waived.pdf` |
| PDF overlay | diagonal green `PAID` stamp | diagonal `WAIVED` watermark |
| Frozen by | `freezePaidPdf()` | `freezeWaivedPdf()` |
| Returns to ISSUED via | `clearDeposit()` / `reverseDeposit()` | `unwaiveVoucher()` |
| Reversal clears the artifact | yes — `paid_pdf_url = null` | yes — `waived_pdf_url = null` |

**The three PDF columns are three distinct objects.** `pdf_url` is the ISSUED
challan (a *cache*), `paid_pdf_url` is the PAID receipt and `waived_pdf_url` is
the WAIVED challan (both *frozen artifacts*). They live under different storage
keys because `prepareVoucherPdfData` appends a `paid` / `waived` suffix.
`storedPdfUrl()` is the single place that maps status → column; never read one
of these columns directly to decide what to serve.

- A stamped render is **never** written into `pdf_url`. If it were, reversing
  the payment or undoing the waiver would leave a stamped file standing as the
  "issued" challan.
- `waiveVoucher()` deliberately **leaves `pdf_url` intact** — it is dormant while
  the voucher is WAIVED (`storedPdfUrl`/`generatePdf` both route to
  `waived_pdf_url`), so un-waiving hands back the byte-identical challan the
  parent was originally issued. This mirrors `recordDeposit()` leaving `pdf_url`
  alone on the way to PAID.
- `unwaiveVoucher()` **does** clear `pdf_url`, because restoring the arrear
  surcharges can land on a different `surcharge_waived` value than the one baked
  into the cached render (the manually-waived-surcharge edge case).
- Storage objects are never deleted on reversal, only unlinked — same orphan
  policy as `generateMainColumnReceipt`.

**Generated on the spot.** Waiving from the deposit page mints and downloads the
WAIVED challan in the same request, the way splitting downloads its PAID receipt
and balance challan. `waiveVoucher()` renders **after** its transaction commits
(`prepareVoucherPdfData` reads `vouchers.status` to pick the watermark, so the
row must already say `WAIVED`), and the render is **non-fatal**: the write-off is
already durable, so a render failure logs and the next `generatePdf()` mints it.

**Check after any change to waive, un-waive, or the PDF freeze:**

1. Waive an UNPAID voucher → status `WAIVED`, every non-discount head `WAIVED`,
   `waived_pdf_url` populated, PDF carries the WAIVED watermark, challan
   downloads without a second click.
2. Ask for that voucher's PDF again → identical URL, `frozen: true`, no
   re-render, no re-upload.
3. Un-waive → heads back to `ISSUED`, status `UNPAID`/`OVERDUE`,
   `waived_pdf_url` null.
4. Re-waive → a **fresh** artifact is minted; the first one is not resurrected.
5. A PAID voucher still resolves to `paid_pdf_url`, never `waived_pdf_url`.
6. `npm test -- waived-pdf-freeze paid-pdf-freeze` green.

---

## Rule D — a wholly waived voucher and a partially waived one look nothing alike

**Invariant.** How a written-off head is *presented* depends entirely on whether
the rest of the voucher is written off too. There are exactly two presentations
and they must never be mixed up. The discriminator is `wholeVoucherWaived` in
`prepareVoucherPdfData` (`waived || voucher.status === 'WAIVED'`) and
`wholeVoucherWaived` in the deposit page's `DepositModal`.

| | Wholly waived | Partially waived |
|---|---|---|
| How it got there | `waiveVoucher()` after issue, **or** `create()` with every non-discount head already `WAIVED` (`issueAsWaived`) | some heads `WAIVED`, the rest billed normally |
| `vouchers.status` | `WAIVED` | `UNPAID` / `OVERDUE` / … — unchanged |
| Diagonal WAIVED stamp | **yes** — it carries the whole message | **no** — most of the voucher is payable |
| Fee-head lines | **printed normally**, full amounts, consolidated into month ranges like any other challan | the waived line is **struck through** and tagged `WAIVED` |
| Total | the real total, as if nothing were waived | excludes the waived heads |
| `feeHeads[].isWaived` | **never set** — the heads fall through to ordinary rendering | set, with `waivedAmount` |
| Deposit modal | opens **read-only** (View button on the row): stamp, banner, no amount box, no Record Deposit | ordinary deposit form; the struck rows take no distribution |

**The two routes into WAIVED must agree.** Waive-after-issue and
issue-already-waived are the same write-off and must print and list identically.
`waiveVoucher()` leaves `total_payable_before_due` / `_after_due` at the heads'
original face value, so `create()`'s `issueAsWaived` stores
`totalWaivedDecimal` — the heads' face value — rather than zero. Nothing bills
off these columns: a WAIVED voucher is skipped on its **status** alone by
`normalizeVoucher`, `computeArrears` and `recordDeposit`.

**A waived head is excluded by value, not just by display.** On a mixed voucher
`student_fees` still holds the full charge with `amount_paid = 0`, so anything
that derives a balance from it must skip the head explicitly:

- `normalizeVoucher` skips it exactly as it skips discount rows. Left in, it
  inflates `total_balance` **and** makes `allHeadsPaid` unreachable, so the
  voucher can never settle to `PAID` however much is collected.
- `recordDeposit` rejects a **non-zero** distribution to a `voucher_heads.waived`
  row, the same way it rejects one to a waived surcharge. Zero entries must keep
  passing — the deposit UI sends a `0` for every head it renders.
- The deposit modal's `sfBalance()` returns 0 for a struck-out head, which is
  what keeps auto-fill from pouring money into it.

**Check after any change here:**

1. Waive an issued voucher → challan prints its heads normally under the stamp;
   the deposit row's View button opens a read-only modal with the same numbers.
2. Waive loose heads, then generate a voucher for exactly those heads → byte-for-
   byte the same presentation as (1), same total, not zero.
3. Generate a voucher mixing one waived head with payable ones → no stamp, the
   waived line struck through, the total excludes it, and paying the rest in full
   moves the voucher to `PAID`.
4. `npm test -- waived-head-totals waived-pdf-freeze` green.

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

**A sweep is not a find-and-replace.** These statuses are terminal in different
ways and a blanket "add X next to VOID everywhere" will be wrong somewhere. Judge
each site on what it is actually asking:

| The site is asking | `VOID` | `EXPIRED` | `WAIVED` |
|---|---|---|---|
| can it take a deposit? | no | no | no |
| show it as the student's active voucher? | no | no | no |
| was it replaced by a newer voucher? | **yes** | **NO** | **NO** |

The first two rows are why `EXPIRED` belongs beside `VOID` in most places. The
third row is the one that bites: it governs reactivation on delete, and `7b6dda5`
got it wrong by treating a status sweep as mechanical. See **Rule A**,
"Never re-add `EXPIRED` to that exclusion".
