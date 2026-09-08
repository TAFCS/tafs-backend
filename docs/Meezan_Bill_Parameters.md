# Meezan Bank — Bill Collection Parameters (TAFS)

**Prepared:** 8 September 2026
**Prepared by:** TAFS Development Team
**Purpose:** Supply the parameters requested by Meezan Bank for the Bill Collection
integration — payment amount limits and voucher number specification.

---

## 1. Payment Amount Limits

Figures below are taken from the live `student_fees` table (every fee head raised
to date). Fee heads belonging to students whose name contains **"TEST"** have been
excluded, as have discount lines (which are negative adjustments, not payable
heads).

| Parameter | Value (PKR) | Source |
|---|---|---|
| **Minimum payment** | **5** | Lowest single fee head — `student_fees.id = 35778` ("BALANCE PAYMENT OF …", student *ANUM REHAN*, 2026‑2027) |
| **Maximum payment** | **212,379** | Highest single fee head — `student_fees.id = 12709` (student *AMNA FATIMA*, 2026‑2027) |

Basis: 25,434 payable (non‑discount, positive) fee heads across all campuses,
TEST students removed.

**Practical note for the amount field.** A voucher is a bill that may bundle
several fee heads plus, when overdue, a fixed **PKR 1,000** late surcharge
(`Amount_AD_Date = Amount_WID_Date + 1,000`). The bill amount presented to the
payer is therefore the **sum of the heads on that voucher**, which can exceed the
single‑head maximum above. If Meezan needs a hard ceiling for validation we
recommend setting it no lower than **PKR 500,000** to leave head‑room for
multi‑head and multi‑month vouchers. The minimum transaction amount is **PKR 5**.
All amounts are whole rupees (no paisa) and are sent as strings.

---

## 2. Voucher Number Specification

| Attribute | Value |
|---|---|
| **Field name (API)** | `VoucherNumber` |
| **Type** | Numeric string |
| **Length** | **Fixed — exactly 11 digits**, always (zero‑padded; never fewer, never more) |
| **Character set** | Digits `0`–`9` only |
| **Format** | `MMYYNNNNNNN` |

### Segment breakdown

| Position | Length | Segment | Meaning |
|---|---|---|---|
| 1–2 | 2 | `MM` | Month of the voucher's fee/billing date, `01`–`12` |
| 3–4 | 2 | `YY` | Year of the voucher's fee/billing date, last 2 digits (e.g. `26` = 2026) |
| 5–11 | 7 | `NNNNNNN` | Internal voucher ID, zero‑padded to 7 digits |

The 7‑digit ID segment supports up to **9,999,999** vouchers. Current highest
voucher ID in production is 10,669, so the padding is `0010669`.

### Examples

| VoucherNumber | MM | YY | ID | Reading |
|---|---|---|---|---|
| `12260010669` | 12 | 26 | 0010669 | December 2026, voucher #10669 |
| `09260010665` | 09 | 26 | 0010665 | September 2026, voucher #10665 |
| `05260003357` | 05 | 26 | 0003357 | May 2026, voucher #3357 |

Verified against production: every issued voucher number is exactly 11 characters.

> The related field `BillingMonth` in the Bill Inquiry response is the same
> period in **`YYMM`** order (e.g. `2612` for December 2026) — note that is
> `YYMM`, the reverse of the `MMYY` prefix inside the voucher number itself.
