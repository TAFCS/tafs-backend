# TAFS Voucher System — Architecture Rundown & Centralization Plan

---

## 1. How Things Work Right Now

### A. Single Voucher Issuance (`vouchers.service.ts`)

The flow is initiated from `fee-challan/page.tsx` → API → `VouchersService.create()`.

```
UI (fee-challan/page.tsx)
  └─ POST /vouchers  (CreateVoucherDto)
       └─ VouchersService.create()
            ├─ computeArrears()          — finds outstanding older fees
            ├─ $transaction()
            │    ├─ vouchers.create()
            │    ├─ voucher_heads.createMany()  — one row per fee line
            │    ├─ student_fees.update() → status = ISSUED
            │    ├─ vouchers.update()     — final totals (surcharge included)
            │    ├─ voucher_arrear_surcharges.createMany()
            │    └─ old vouchers → VOID if heads overlap
            └─ upload PDF (optional pdfBuffer param)
```

**PDF generation** for single vouchers is done separately via `VouchersService.generatePdf(id)`:
```
VouchersService.generatePdf(voucherId)
  └─ prepareVoucherPdfData(voucher)   — maps DB data → VoucherPdfData shape
       └─ pdfService.generateVoucherPdf(data)
            └─ React.createElement(FeeChallanPDF, props)  ← BACKEND copy
```

The `prepareVoucherPdfData()` method:
- Fetches siblings
- Computes installment sequence numbers
- Maps every `voucher_head` row to a `FeeItem`
- Reads `voucher_arrear_surcharges` for surcharge data (not re-computed)
- Builds consolidated month labels and arrears history

---

### B. Bulk Voucher Jobs (`bulk-voucher-jobs.service.ts`)

The flow is from `bulk-voucher/page.tsx` → API → `BulkVoucherJobsService.startJob()`.

```
UI (bulk-voucher/page.tsx)
  └─ POST /bulk-voucher-jobs/start
       └─ BulkVoucherJobsService.startJob()
            └─ setImmediate(() => processJob())   — fire-and-forget
                 ├─ Phase 1: bulk DB pre-fetches (students, fees, vouchers)
                 ├─ Phase 2: build WorkItems per student×month + skip detection
                 └─ Phase 3: parallel batches → processWorkItem()
                      ├─ vouchersService.computeArrears()     ✅ shared
                      ├─ vouchersService.create()             ✅ shared
                      └─ CUSTOM PDF BUILD (NOT via prepareVoucherPdfData)
                           ├─ Manual tuition consolidation
                           ├─ Manual arrear head building
                           └─ voucherPdfService.generateVoucherPdf()   ✅ same renderer
```

### C. Paid Challan Regeneration

When a user clicks "Download Paid" in `fee-challan/page.tsx`:

```
UI → GET /vouchers/:id/pdf?paid=true
  └─ VouchersService.generatePdf(id, showDiscount=true, paidStamp=true)
       └─ prepareVoucherPdfData(voucher, paidStamp=true)
            └─ READS from voucher_heads (already stored in DB)
                 ✅ No re-computation of arrears
                 ✅ Reads voucher_arrear_surcharges from DB
```

This is correct in principle but `prepareVoucherPdfData()` maps differently from `processWorkItem()`.

### D. The Two PDF Components

| Location | Used By | Rendering Method |
|---|---|---|
| `tafs-backend/src/modules/voucher-pdf/FeeChallanPDF.tsx` | Backend PDF generation (single + bulk) | `renderToBuffer()` on Node |
| `tafs-webapp/components/fees/FeeChallanPDF.tsx` | Frontend preview in `fee-challan/page.tsx` | React in-browser |

These two files are **manually kept in sync**. Any change to one must be duplicated in the other.

---

## 2. The Problems Clearly Stated

### Problem 1 — Dual PDF Build Paths
`processWorkItem()` in bulk jobs manually constructs `feeHeads` for the PDF from scratch using raw `student_fees` data. `generatePdf()` in single vouchers uses `prepareVoucherPdfData()` which reads from `voucher_heads` (already stored). These two paths produce different label formats, different month consolidation, and different arrear presentation — they **will drift** every time you touch one.

### Problem 2 — Paid Challan Uses DB Reads, Bulk Uses Fresh Data
Paid challan is correct because it reads from `voucher_heads` in the DB. Bulk builds feeHeads from `student_fees` pre-fetch data **before** the voucher is in the DB. If `create()` changes how heads are stored, bulk PDF output won't automatically follow.

### Problem 3 — Two Frontend/Backend PDF Files
Styling, month labels, arrear section rendering, installment sequences — all duplicated across two `FeeChallanPDF.tsx` files. One change = two edits.

### Problem 4 — Month Consolidation Logic Duplicated
`getConsolidatedMonthsLabel()` and `getMonthYearLabel()` exist **only** in `bulk-voucher-jobs.service.ts`. The single voucher `prepareVoucherPdfData()` has its own month label logic using different code. They can drift.

### Problem 5 — `computeArrears()` Called Twice in Bulk
Bulk calls `computeArrears()` to get `arrearFeeIds`, then calls `create()` which internally calls `computeArrears()` again inside the transaction. This is a redundant DB hit per student.

---

## 3. The Centralization Plan

The goal: **one path to generate a voucher PDF**, whether it's single, bulk, or paid/stamped.

```
createVoucher() → stored in DB → generatePdfFromVoucher(id) → FeeChallanPDF
```

### Phase 1 — Merge the PDF Build Path (Most Critical)

**After `vouchersService.create()` returns, call `generatePdf()` directly.** This eliminates the manual `feeHeads` build in `processWorkItem()`.

The bulk job `processWorkItem()` should become:

```typescript
// 1. Create the voucher (same as now)
const voucher = await this.vouchersService.create({ ... });

// 2. Generate PDF using the SAME path as single voucher
const { pdf_url } = await this.vouchersService.generatePdf(voucher.id);
const pdfBuffer = await fetch(pdf_url).then(r => r.buffer());
```

Or better, expose a `generatePdfBuffer(voucherId)` method that returns the buffer without uploading, and then bulk can merge them.

**Impact:**
- Every logic change in `prepareVoucherPdfData()` automatically applies to bulk
- Paid challan already goes through `generatePdf()` — no change needed there
- `processWorkItem()` shrinks dramatically

### Phase 2 — Extract Month Label Helpers to Shared Module

Create `/src/common/utils/academic-labels.ts`:

```typescript
export function deriveAcademicYear(dateStr: string, classId?: number): string { ... }
export function getMonthYearLabel(m: number, ay: string, classId?: number): string { ... }
export function getConsolidatedMonthsLabel(items: ..., classId?: number): string { ... }
```

Import this in both `vouchers.service.ts` (for `prepareVoucherPdfData`) and `bulk-voucher-jobs.service.ts`.

### Phase 3 — Single Source for the FeeChallanPDF Component

**Option A (Recommended): Backend is the source of truth**

Keep only the backend `FeeChallanPDF.tsx`. For the frontend preview, generate a PDF server-side and embed it as `<iframe src={pdf_url}>` or `<embed>`. This eliminates frontend duplication entirely.

**Option B: Shared package**

Extract the PDF component into a shared workspace package (`packages/fee-challan-pdf`) referenced by both the Next.js app and the NestJS backend. More complex monorepo setup but keeps live preview.

**Option C: Keep two files but auto-sync via script**

A build script that copies backend `FeeChallanPDF.tsx` → frontend. Fragile but zero refactor cost.

> **Recommended: Option A**. The frontend live-preview can be replaced with an iframe loading the server-generated PDF URL — which is already stored after generation.

### Phase 4 — Remove Double `computeArrears()` in Bulk

`create()` already calls `computeArrears()` internally via the transaction. The outer call in `processWorkItem()` is redundant. After Phase 1, `processWorkItem()` only needs to build `orderedFeeIds + fee_lines` and then call `create()`. The `computeArrears` result that was being used for PDF data is no longer needed since `generatePdf()` reads from DB.

```typescript
// BEFORE: processWorkItem()
const arrearsResult = await computeArrears(cc, date);  // ❌ redundant
const arrearFeeIds = arrearsResult.arrear_fee_ids;
const voucher = await vouchersService.create({ orderedFeeIds: [...arrearFeeIds, ...currentIds] });
// ... 80 lines of manual PDF build

// AFTER: processWorkItem()
const arrearsResult = await computeArrears(cc, date);  // still needed for orderedFeeIds only
const voucher = await vouchersService.create({ orderedFeeIds: [...arrearFeeIds, ...currentIds] });
const buffer = await vouchersService.generatePdfBuffer(voucher.id);
return { buffer, url: voucher.pdf_url };
```

### Phase 5 — Expose `generatePdfBuffer()` on VouchersService

Add a method that generates and uploads in one call, returning both the URL and the raw buffer (needed for bulk PDF merging):

```typescript
async generatePdfBuffer(voucherId: number, paidStamp = false): Promise<{ buffer: Buffer; url: string }> {
    const { voucherData, key } = await this.prepareVoucherPdfData(voucher, paidStamp);
    const buffer = await this.pdfService.generateVoucherPdf(voucherData);
    const url = await this.storage.upload(key, buffer);
    await this.prisma.vouchers.update({ where: { id: voucherId }, data: { pdf_url: url } });
    return { buffer, url };
}
```

---

## 4. Target Architecture (After Changes)

```
                        ┌──────────────────────────────┐
                        │   VouchersService.create()   │
                        │  (DB write, surcharge, void) │
                        └──────────────┬───────────────┘
                                       │ returns voucher (with id)
                    ┌──────────────────▼───────────────────┐
                    │  VouchersService.generatePdfBuffer() │
                    │  prepareVoucherPdfData(id)           │
                    │    → reads voucher_heads from DB     │
                    │    → reads voucher_arrear_surcharges │
                    │    → builds FeeItems (one logic)     │
                    │    → calls pdfService.generate()     │
                    │    → uploads to storage              │
                    └───┬──────────────────┬──────────────┘
                        │                  │
              ┌─────────▼──────┐  ┌────────▼────────────┐
              │  Single Voucher │  │  Bulk Job Worker    │
              │  (HTTP handler) │  │  (collects buffers) │
              └─────────────────┘  └────────────────────┘
                                          │
                                   pdfService.mergePdfs()
```

```
FeeChallanPDF.tsx (ONE file, in backend)
  ├── used by pdfService.generateVoucherPdf() (server-side render)
  └── frontend preview = iframe/embed of the stored PDF URL
```

---

## 5. Execution Order

| Step | What | Risk | Effort |
|---|---|---|---|
| 1 | Add `generatePdfBuffer(id)` to `VouchersService` | Zero — additive | Low |
| 2 | Replace `processWorkItem()` PDF build with `generatePdfBuffer()` call | Medium — test bulk output | Medium |
| 3 | Extract academic label helpers to shared util | Low | Low |
| 4 | Replace frontend live preview with iframe | Low visual change | Low |
| 5 | Delete frontend `FeeChallanPDF.tsx` | High — removes duplication | Low |
| 6 | Remove double `computeArrears()` in bulk | Low | Low |

> [!IMPORTANT]
> Steps 1 + 2 give you 80% of the benefit. The bulk PDF output will immediately match single voucher output after step 2.

> [!WARNING]
> Before step 2, run one bulk job and one single voucher for the same student side-by-side to confirm visual parity after the switch. The month consolidation labels may look different initially because `processWorkItem()` consolidated multiple months per date into one PDF head, while `prepareVoucherPdfData()` shows them individually per voucher_head row. You may need to add consolidation logic inside `prepareVoucherPdfData()` to match.

---

## 6. Decision Needed From You

1. **Frontend PDF preview**: Switch to iframe loading the stored PDF URL, or keep the live React preview? If you keep it, the two `FeeChallanPDF.tsx` files must stay in sync.
2. **Bulk PDF consolidation**: The bulk job currently consolidates multiple months (e.g. "AUG 26 – OCT 26") into a single tuition head for PDF. After centralizing, this consolidation should happen inside `prepareVoucherPdfData()`. Should we do this now or in a later pass?
3. **Scrapping the old `createBulk()` in `VouchersService`**: There's a legacy `VouchersService.createBulk()` and `VouchersService.previewBulk()` that appear to be a separate, older bulk path. These seem unused by the current bulk-voucher-jobs flow. Should they be removed?
