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

## PAY IMMEDIATELY — the rules

A voucher issued to a student who has not paid their last two vouchers is a **PAY IMMEDIATELY**
voucher. These rules apply **identically in all three sources above** — single, bulk, and the
split balance voucher. If a change makes one of them behave differently, the change is wrong.

### Rule 1 — when a voucher is PAY IMMEDIATELY

Look only at the student's **arrears** — unpaid heads whose `fee_date` is **strictly before** the
new voucher's own `fee_date`. **Ignore the current fee_date.** Arrears come from
`computeArrears()` and nowhere else (it already excludes `PAID`, `DISCOUNT`, `WAIVED`, surcharge
and discount rows, and heads with nothing outstanding).

The voucher is PAY IMMEDIATELY when those arrears span **both**:

- **at least 2 different `fee_date`s**, and
- **at least 2 different target months** (distinct `(academic_year, target_month)`).

Two fee_dates with two target months means two vouchers were issued to the family and neither
was paid. **Both conditions are required** — this is the part that is easy to get wrong:

| Arrears | Fee dates | Target months | PAY IMMEDIATELY? |
|---|---|---|---|
| Aug voucher + Sep voucher unpaid | 2 | 2 | **yes** |
| Aug, Sep, Oct, Nov all unpaid | 4 | 4 | **yes** |
| A whole year billed on **one** fee_date, unpaid | 1 | 12 | **no** — one unpaid voucher |
| Two fee_dates for the same month | 2 | 1 | **no** |
| Only last month unpaid | 1 | 1 | no |

The annual-billing row is real: counting target months alone (the first implementation did)
wrongly flagged 25 of the 550 students with arrears on 2026-09-11.

Any outstanding balance counts as unpaid — a Rs 50 leftover on an old head still makes that
fee_date an unpaid voucher. That is the rule as specified, not a rounding bug.

### Rule 2 — what a PAY IMMEDIATELY voucher gets

- **`due_date` = `validity_date` = `issue_date` + 4 days, not counting Sundays.** Both are
  forced, overriding whatever the user typed or the bulk job / split form sent. The family has
  four days to pay before the voucher expires. Count forward from the issue date and skip every
  Sunday, so any window that crosses a Sunday becomes **+5** — issued on a **Friday**, it is due
  the next **Wednesday**. The due date is never a Sunday. Only Sundays are skipped (not
  Saturdays, not holidays).

  | Issued | Days counted | Due | Offset |
  |---|---|---|---|
  | Sun | Mon Tue Wed Thu | Thu | +4 |
  | Mon | Tue Wed Thu Fri | Fri | +4 |
  | Tue | Wed Thu Fri Sat | Sat | +4 |
  | Wed | Thu Fri Sat ~~Sun~~ Mon | Mon | +5 |
  | Thu | Fri Sat ~~Sun~~ Mon Tue | Tue | +5 |
  | Fri | Sat ~~Sun~~ Mon Tue Wed | Wed | +5 |
  | Sat | ~~Sun~~ Mon Tue Wed Thu | Thu | +5 |

  Computed only by `payImmediateDueDate()`, in UTC (`getUTCDay() === 0` is Sunday — the columns
  are `@db.Date` at UTC midnight).
- **`vouchers.pay_immediately = true`**, written once at issuance and never recomputed — a
  reprint shows what was issued, even if the family has since paid the older vouchers.
- **One big diagonal red "PAY IMMEDIATELY" watermark across the whole page** — one mark for the
  page, not one per copy, drawn **on top** of everything.

### Rule 3 — the system-settings toggle governs all three

Everything above happens **only while `app_config.pay_immediately_enabled` is `'true'`** —
the "PAY IMMEDIATELY Vouchers" switch on **`/admin/developer`** (SUPER_ADMIN only; also
`PATCH /v1/app-config/pay_immediately_enabled`). Seeded `'false'`. All three sources read the
same key via `isPayImmediateEnabled()`, so flipping it changes single, bulk and split together, on
the very next voucher (no cache). Never add a per-source switch, and never remove the check.

The toggle only decides what **new** vouchers get. Turning it off does not strip the watermark
or dates from vouchers already issued as PAY IMMEDIATELY (Rule 2: `pay_immediately` is frozen).

### Never PAY IMMEDIATELY

- A **PAID** voucher's receipt or a **WAIVED** challan — the watermark is suppressed on those
  renders even if `pay_immediately` is true.
- The split's **PAID receipt** — only the split's **balance** voucher is ever eligible.
- A split with `balance_disposition = DO_NOT_ISSUE` — there is no balance voucher.
- A fully-waived challan (`issueAsWaived`) — it skips `computeArrears()` entirely.
- A voucher with no `fee_date` — no arrears can be computed, in either `create()` or the split.

### Where it is enforced — one rule, three sources

The rule is written **once**, as module-level functions at the top of `vouchers.service.ts`:
`isPayImmediate()` (Rule 1), `payImmediateDueDate()` (Rule 2 dates), and the constants
`PAY_IMMEDIATE_MIN_UNPAID_VOUCHERS` / `PAY_IMMEDIATE_DUE_DAYS`. Each source calls them; **never
re-inline the rule at a call site.**

| # | Source | Where | What it does |
|---|---|---|---|
| 1 | `/fee-challan` single | `create()`, right after `computeArrears()` | `isPayImmediate(arrearsInfo) && isPayImmediateEnabled(tx)` → forces dates, sets `pay_immediately` |
| 2 | Bulk job | same code — bulk calls `create()` once per student | same; decided **per student**, so one bulk job can mix PAY IMMEDIATELY and normal vouchers |
| 3 | Split balance voucher | `splitPayImmediate()`, called **first** in the split's transaction — before Step 1 re-dates anything | same rule + toggle, arrears relative to the balance voucher's fee_date, read-only; applied to the `unpaid` insert only |

**Why the split decides before Step 1.** `use_nearest_future_fee_date` / `balance_fee_date` move a
partially-paid head's balance to a later fee_date. Checking afterwards made the answer depend on
where that bookkeeping option filed the balance; whether the family has two unpaid vouchers
must not.

**Deposit page prefill.** `GET /v1/vouchers/:id/split-preview?issue_date=YYYY-MM-DD` →
`previewSplitPayImmediate()` calls the same `splitPayImmediate()` and `payImmediateDueDate()`,
so the split modal can prefill (and lock) the due/validity date the split will enforce. It
writes nothing. Never compute the rule in the webapp — ask this endpoint.

**The watermark is decided in `prepareVoucherPdfData()`, from the voucher row** —
`pay_immediately && !paidStamp && !waived`. Callers do not pass it. It used to be a parameter,
and the split's balance-voucher render forgot to pass it: the voucher was stored
`pay_immediately = true` with the 4-day dates but downloaded **without** the watermark. Deriving
it from the row means every render path (single, bulk, split, regenerate, reprint) agrees.

### Watermark rendering — two traps already hit

Both in `FeeChallanPDF.tsx` (mirrored in `FeeChallanPDF_MeezanBank.tsx`):

1. **Z-order.** react-pdf has no `z-index`; it stacks in document order. The watermark must be
   the **last** child of `<Page>` to paint on top. As the first child it sat behind the tables.
2. **Spurious second page.** react-pdf counts an absolute box's overflow when deciding page
   breaks. A full-page-height watermark box made **every** PAY IMMEDIATELY voucher print a blank
   second page. The outer box is clamped to the flow area (`CONTENT_HEIGHT - QR_RESERVE`); the
   inner box carries the full page size for coverage — the same nesting the challan block uses.
   It is not `fixed`, so it stays on page 1 when a long history column overflows to page 2.

### Check after touching any of this

1. `npm test -- pay-immediately` — the Rule 1 table and the Rule 2 dates (every issue weekday,
   never a Sunday), including the annual-billing case.
2. With the toggle **on**, issue for a student with two unpaid vouchers from each source:
   `/fee-challan`, a bulk job, and a split's balance voucher. All three: due = validity =
   issue + 4 days with Sundays not counted (a Friday issue is due Wednesday),
   `pay_immediately = true`, watermark on top, **one page**.
3. Same student with the toggle **off**: all three issue normally.
4. A student whose arrears are one annual voucher: never PAY IMMEDIATELY.

If you're adding the next cross-cutting voucher-issuance feature, follow this pattern: write the
rule once, call it from both `create()` and `splitPartiallyPaid()`, and derive any PDF effect from
the voucher row inside `prepareVoucherPdfData()` rather than threading it through callers.

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
