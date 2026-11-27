# Extracurricular (EC) fees: rules

TAFSD-605. Extracurricular charges (scouts, co-curriculars, clubs) are billed on
their own vouchers, **never mixed with academic fees**. This module is the whole
flow, kept apart from academic fees: fee heads → class amounts → student charges
→ vouchers → deposits → payment history → reports.

These are fixed rules. If a change breaks one, the change is wrong, not the rule.
The academic finance rules in `tafs-backend/CLAUDE.md` do **not** apply to these
tables, and these rules do not apply to the academic ones.

## Tables

| Table | Twin of | Holds |
|---|---|---|
| `ec_fee_heads` | `fee_types` | name, frequency (MONTHLY / ONE_TIME), months 1–12 |
| `ec_class_fee_schedule` | `class_fee_schedule` | amount per class, head, campus (null = all) and year |
| `ec_student_charges` | `student_fees` | what one student owes for one head in one month |
| `ec_vouchers` | `vouchers` | the challan: issue date, expiry date, status, totals |
| `ec_voucher_lines` | `voucher_heads` | one charge on one voucher |
| `ec_deposits` | `deposits` | money received against exactly one voucher |
| `ec_deposit_allocations` | `deposit_allocations` | how a deposit splits across lines |

## Rules

1. **Separation.** EC code never reads or writes `vouchers`, `voucher_heads`,
   `voucher_arrear_surcharges`, `student_fees`, `deposits`,
   `deposit_allocations` or `family_credit_ledger`. Academic code never reads
   `ec_*`. Students, campuses, classes, sections and bank accounts are shared
   reference data, read only. So EC dues never reach academic arrears,
   defaulters, fee reports, or the exam-documents dues check.
2. **One voucher per charge.** `ec_student_charges.current_voucher_id` is the one
   voucher billing a charge now (live or lapsed); null means NOT_ISSUED. It is
   set only by compare-and-set (`updateMany` where it is null, or equals the old
   id; the count must match, otherwise 409 and roll back).
3. **No arrears, no voiding.** Issuing never changes another voucher. Older open
   vouchers appear only in the challan's side panel ("not included in this
   voucher") and in payment history, never in a total. There is no VOID status.
4. **No due date, no late fee.** A voucher has an issue date and an expiry date
   (valid through the expiry day, Pakistan time) and one payable amount.
5. **EXPIRED and REISSUED are derived, never stored.** Stored statuses are
   UNPAID, PARTIALLY_PAID, PAID, WAIVED. No cron. One helper turns a voucher
   into its shown state, and the same helper builds the list filters.
6. **Money is written in one place** (`recomputeVoucherInTx`): line, charge and
   voucher totals and statuses are re-derived from the allocations, never
   incremented or decremented by hand. It throws if a line would be over-paid.
7. **Deposits** need: voucher UNPAID or PARTIALLY_PAID and not reissued;
   `issue_date ≤ deposit_date ≤ min(today, expiry_date)` (the bank-stamp date, so
   a challan paid before expiry can be recorded later); `0 < amount ≤ balance`,
   each line ≤ its remainder. No excess, no family credit. Every money
   transaction locks the voucher row (`SELECT … FOR UPDATE`).
8. **Reversal in descending order.** Only the latest deposit on a voucher, and
   not on a reissued or waived voucher. Hard delete plus an audit row holding
   the whole deposit, then recompute.
9. **Reissue** is for expired vouchers only: a new voucher for each charge's
   remainder, charges moved old → new by compare-and-set. The old voucher is
   history (REISSUED) and leaves the lapsed totals.
10. **Delete** fixes mistakes: no deposits, not waived, no successor. Charges go
    back to the predecessor (if it was a reissue), otherwise to NOT_ISSUED.
11. **Waive** writes off a voucher's whole remainder with a reason (expired
    vouchers too); unwaive reverses it. Part-paid then waived shows WAIVED.
12. **PDFs.** The paid receipt is written once. The challan never prints a 1Bill
    consumer number or the CC as a payment reference, and says it can't be paid
    through 1Bill, banking apps or the CC number.
13. **Server-side.** Every rule is enforced in the shared service functions, which
    every path (single, bulk, reissue, pages) goes through; never only in the UI.
14. **Whole rupees.** Every EC amount is a whole number.
15. **Academic year** is stored as `YYYY-YYYY` (`normalizeEcAcademicYear`).

## Access

The Extracurricular Fees module (`extracurricular.*` tiles) is granted per
person like every web tile; no role or pack gets it by default. Every route
carries `@RequireAction` / `@RequireAnyAction` / `@RequireAnyTile`; a new route
needs its own action (see the MAINTENANCE note in `tiles.manifest.ts`). Shared
feeders use `EC_LIVE_TILES` (`ec.constants.ts`), which must list exactly the EC
tiles in the manifest. Scope: out of scope is 404.
