# Meezan Bank — TAFS Integration API Guide

## Base URL

```
https://tafs-backend-production.up.railway.app/api/v1/meezan
```

---

## Authentication

Every request must include these three fields in the JSON body:

| Field | Value |
|---|---|
| `ServiceUserId` | `0b986d818b54b6eeedbf7658` |
| `UserPassword` | `e67f36b15bd1d034017854db2486a82b` |
| `BillCompanyCode` | `TAFCS` |

---

## 1. Bill Inquiry

Fetch unpaid voucher details before processing a payment.

### Endpoint

```
POST /bill-inquiry
```

### Request Body

```json
{
  "ServiceUserId": "0b986d818b54b6eeedbf7658",
  "UserPassword": "e67f36b15bd1d034017354db2486a82b",
  "BillCompanyCode": "TAFCS",
  "VoucherNumber": "05260003357"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `ServiceUserId` | string | Yes | Service authentication ID |
| `UserPassword` | string | Yes | Service authentication password |
| `BillCompanyCode` | string | Yes | Company identifier |
| `VoucherNumber` | string | Yes | The voucher number to look up |

### Success Response

**HTTP 200** — Voucher found and unpaid:

```json
{
  "StatusCode": "00",
  "StatusDesc": "Unpaid",
  "student_name": "TEST STUDENT B",
  "student_id": "2",
  "due_date": "20260521",
  "Amount_WID_Date": "50000",
  "Amount_AD_Date": "51000",
  "BillingMonth": "2504"
}
```

| Field | Description |
|---|---|
| `StatusCode` | `00` = success |
| `StatusDesc` | `Unpaid` = voucher not yet paid |
| `student_name` | Full name of the student |
| `student_id` | Student CC number |
| `due_date` | Due date in `YYYYMMDD` format |
| `Amount_WID_Date` | Amount payable on or before due date (in PKR) |
| `Amount_AD_Date` | Amount payable after due date — includes a surcharge of PKR 1,000 if overdue |
| `BillingMonth` | Billing period in `YYMM` format |

### Error Responses

| ResponseCode | ResponseDesc | Meaning |
|---|---|---|
| `091` | Voucher Id is invalid | No voucher found for the given number |
| `092` | Voucher date is expired | Voucher validity date has passed |
| `094` | User invalid | Wrong `ServiceUserId` or `UserPassword` |
| `095` | Company code mismatch | Wrong `BillCompanyCode` |
| `096` | General exception | Server-side error |
| `097` | Already Paid | Voucher has already been paid |

---

## 2. Bill Payment

Post a payment against a voucher. This marks the voucher as paid and allocates amounts to the relevant fee heads.

### Endpoint

```
POST /bill-payment
```

### Request Body

```json
{
  "ServiceUserId": "0b986d818b54b6eeedbf7658",
  "UserPassword": "e67f36b15bd1d034017354db2486a82b",
  "BillCompanyCode": "TAFCS",
  "VoucherNumber": "05260003357",
  "TransDate": "20260512",
  "TransAmount": "50000",
  "TransAuthenticationCode": "AUTH123456",
  "PaymentMode": "ONLINE",
  "Status": "C",
  "ChequeNo": "",
  "ReasonCode": "",
  "ReasonDescription": ""
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `ServiceUserId` | string | Yes | Service authentication ID |
| `UserPassword` | string | Yes | Service authentication password |
| `BillCompanyCode` | string | Yes | Company identifier |
| `VoucherNumber` | string | Yes | The voucher number to pay |
| `TransDate` | string | Yes | Transaction date in `YYYYMMDD` format |
| `TransAmount` | string | Yes | Amount paid in PKR (as a string) |
| `TransAuthenticationCode` | string | Yes | Bank-issued transaction reference/auth code |
| `PaymentMode` | string | Yes | Payment mode (e.g. `ONLINE`, `CHEQUE`, `CASH`) |
| `Status` | string | Yes | Transaction status: `C` = Cleared/Posted, `R` = Returned, `L` = Lodged |
| `ChequeNo` | string | No | Cheque number (only for cheque payments) |
| `ReasonCode` | string | No | Reason code (only when `Status` = `R`) |
| `ReasonDescription` | string | No | Reason description (only when `Status` = `R`) |

### Status Values

| Status | Meaning | Action taken |
|---|---|---|
| `C` | Cleared — payment confirmed | Voucher marked PAID, fees allocated |
| `R` | Returned — payment rejected | No update; reason logged |
| `L` | Lodged — payment pending | No update; logged only |

> Only `Status: "C"` triggers actual payment processing. `R` and `L` are acknowledged and logged but do not update the voucher.

### Success Response

**HTTP 200** — Payment posted successfully:

```json
{
  "StatusCode": "00",
  "StatusDesc": "Success"
}
```

### Lodged / Returned Response

**HTTP 200** — Payment received but not posted:

```json
{
  "StatusCode": "00",
  "StatusDesc": "Lodged/Returned — not posted"
}
```

### Error Responses

| ResponseCode | ResponseDesc | Meaning |
|---|---|---|
| `091` | Voucher Id is invalid | No voucher found for the given number |
| `092` | Voucher date is expired | Voucher validity date has passed |
| `094` | User invalid | Wrong `ServiceUserId` or `UserPassword` |
| `095` | Company code mismatch | Wrong `BillCompanyCode` |
| `096` | General exception | Server-side error |
| `097` | Voucher already paid | Voucher has already been paid |

---

## Overdue Surcharge Logic

If the transaction date (`TransDate`) is **after** the voucher due date, an overdue surcharge of **PKR 1,000** is automatically included in the payable amount.

- `Amount_WID_Date` — amount if paid **on or before** due date
- `Amount_AD_Date` — amount if paid **after** due date (`Amount_WID_Date + 1,000`)

When processing payment, always send the correct amount based on the payment date relative to the due date.

---

## Recommended Integration Flow

```
1. POST /bill-inquiry  (VoucherNumber)
        ↓
   Check StatusCode == "00" and StatusDesc == "Unpaid"
        ↓
   Compare today vs due_date → use Amount_WID_Date or Amount_AD_Date
        ↓
2. POST /bill-payment  (VoucherNumber + TransAmount + Status: "C")
        ↓
   Check StatusCode == "00" and StatusDesc == "Success"
```
