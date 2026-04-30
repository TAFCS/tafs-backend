# TAFS — Complete Implementation Plan
## Part A: Centralization Status Audit | Part B: Bulk Delete Page | Part C: Fee Heads & Batch Generation Page

---

## PART A — Centralization Status Audit

### ✅ What Has Been Applied

| Plan Step | Status | Evidence |
|---|---|---|
| **Phase 1** — `generatePdfBuffer(id)` exposed on `VouchersService` | ✅ Done | `vouchers.service.ts:1165` — method exists, reads from DB |
| **Phase 1** — `processWorkItem()` calls `generatePdfBuffer()` | ✅ Done | `bulk-voucher-jobs.service.ts:563` — single-line call |
| **Phase 2** — `academic-labels.ts` shared util extracted | ✅ Done | Both services import from `../../common/utils/academic-labels` |
| **Phase 5** — `pre_computed_surcharge_groups` passed from bulk to avoid double compute | ✅ Done | `bulk-voucher-jobs.service.ts:560` passes `arrearsResult.surcharge_groups` |

### ❌ What Is Still Outstanding

| Plan Step | Status | Notes |
|---|---|---|
| **Phase 3** — Frontend `FeeChallanPDF.tsx` replaced with iframe | ❌ Not done | Two PDF files still exist (frontend + backend). Decision pending from you. |
| **Phase 3** — Frontend live preview removed | ❌ Not done | `fee-challan/page.tsx` still renders PDF client-side |
| **Phase 6** — `createBulk()` / `previewBulk()` legacy methods removed | ❌ Not done | These old methods still exist in `VouchersService` |

### Summary
The critical path (PDF generation unified through one `generatePdfBuffer()` call) **is fully applied**. Bulk vouchers now use the same code path as single vouchers. The two remaining items are cleanup/debt work only and do not affect correctness.

---

## PART B — Bulk Voucher Delete Page

### Overview
A management page at `/bulk-delete` that allows administrators to filter vouchers by campus, class, section, date range, and status — then select and hard-delete them in bulk. Deletion calls the existing single-voucher `remove()` endpoint for each selected voucher (which already resets `student_fees` to `NOT_ISSUED`).

---

### B1 — Backend

#### B1.1 — New Bulk Delete Endpoint
Add `DELETE /api/v1/vouchers/bulk` to `VouchersController`. Does **not** need a new service method — it iterates over IDs and calls the existing `remove(id)` for each.

**File:** `tafs-backend/src/modules/vouchers/vouchers.controller.ts`

```typescript
@Delete('bulk')
@UseGuards(JwtStaffGuard, PoliciesGuard)
@CheckPolicies((ability) => ability.can(Action.Delete, 'Voucher') || ability.can(Action.Manage, 'all'))
async bulkRemove(@Body() dto: BulkDeleteVouchersDto) {
    const results = await this.vouchersService.bulkRemove(dto.ids);
    return {
        success: true,
        message: `${results.deleted} vouchers deleted, ${results.skipped} skipped (non-deletable status).`,
        data: results,
    };
}
```

**File:** `tafs-backend/src/modules/vouchers/dto/bulk-delete-vouchers.dto.ts` *(new)*

```typescript
export class BulkDeleteVouchersDto {
    @IsArray()
    @IsInt({ each: true })
    ids: number[];
}
```

**File:** `tafs-backend/src/modules/vouchers/vouchers.service.ts` — add `bulkRemove()`:

```typescript
async bulkRemove(ids: number[]) {
    let deleted = 0, skipped = 0;
    const errors: { id: number; reason: string }[] = [];

    for (const id of ids) {
        try {
            await this.remove(id);
            deleted++;
        } catch (e) {
            skipped++;
            errors.push({ id, reason: e.message });
        }
    }
    return { deleted, skipped, errors };
}
```

> [!NOTE]
> Sequential loop (not parallel) intentionally — prevents DB deadlocks on concurrent `student_fees` updates for the same student.

---

### B2 — Frontend Page

**Route:** `tafs-webapp/app/(dashboard)/bulk-delete/page.tsx` *(new)*

#### B2.1 — Filters Panel
- Campus dropdown (existing API)
- Class dropdown (filtered by campus)
- Section dropdown (filtered by class)
- Status multiselect: `UNPAID | OVERDUE | VOID`
- Date range: Issue Date From / To (ISO date pickers)
- Academic Year input (free text or dropdown)

#### B2.2 — Voucher Results Table

Columns:
| Voucher # | Student CC | Student Name | Class | Section | Fee Date | Status | Total Amount | Issue Date |
|---|---|---|---|---|---|---|---|---|

- Select-all checkbox in header
- Per-row checkbox
- Status badge with color coding (UNPAID=yellow, OVERDUE=red, VOID=grey)
- Row-level "Delete" button (calls single `DELETE /vouchers/:id`)

#### B2.3 — Bulk Action Bar

Appears when ≥1 row is selected:
```
[X vouchers selected]   [Delete Selected]   [Clear Selection]
```

On "Delete Selected":
1. Show confirmation modal: "You are about to delete X vouchers. This will reset all linked student_fees to NOT_ISSUED. This cannot be undone."
2. Call `DELETE /api/v1/vouchers/bulk` with selected IDs
3. Show result summary: "X deleted, Y skipped" with expandable error list

#### B2.4 — UI State
- Loading skeleton while fetching
- Empty state when no results
- Post-delete: auto-refresh results table
- Error toast for any skipped/failed vouchers with reason

#### B2.5 — API Calls
```
GET  /api/v1/vouchers?campus_id=&class_id=&section_id=&status=&date_from=&date_to=&page=&limit=
DELETE /api/v1/vouchers/bulk   { ids: number[] }
```

---

## PART C — Fee Heads Preview & Batch Generation Page

### Overview
A smart page at `/batch-issue` that lets admins:
1. Select a **date range** (from → to, representing fee months to cover)
2. Optionally filter by campus / class / section
3. See a **preview table** of all `student_fees` heads in that range, grouped by student — with voucher grouping suggestions
4. Run **batch generation** with customizable options per group

This is effectively a smarter, more transparent version of the existing Bulk Voucher page — it shows *what will be generated* before generating.

---

### C1 — Backend

#### C1.1 — Preview Endpoint
`POST /api/v1/vouchers/batch-preview`

Returns grouped fee data: for each student in the filtered range, which `student_fees` heads exist, their status, and how they'd be grouped into vouchers (one per fee_date).

**New DTO:** `BatchPreviewDto`
```typescript
{
  campus_id: number;
  class_id?: number;
  section_id?: number;
  fee_date_from: string;  // ISO date
  fee_date_to: string;    // ISO date
  academic_year?: string; // auto-derived if omitted
  include_statuses?: fee_status_enum[]; // default: ['NOT_ISSUED']
}
```

**Response shape per student:**
```typescript
{
  cc: number;
  full_name: string;
  class: string;
  section: string;
  voucher_groups: [
    {
      fee_date: string;
      academic_year: string;
      heads: [
        {
          id: number;
          fee_type: string;
          target_month: number;
          amount: number;
          status: string;
        }
      ];
      already_issued: boolean;  // true if an UNPAID/PAID voucher exists for this fee_date
      skip_reason?: string;     // populated if already_issued
    }
  ]
}
```

**Implementation:** Lives inside `VouchersService.batchPreview()`. Reuses the same bulk job Phase 1 (student fetch) and Phase 2 (WorkItem building) logic from `BulkVoucherJobsService` — extracted to a shared helper so both this preview endpoint and the actual bulk job processor call the same code.

> [!IMPORTANT]
> This is the key architectural win: `batchPreview()` and the bulk job's Phase 2 will share the exact same "which fees belong to which voucher group" logic.

#### C1.2 — Batch Issue Endpoint
`POST /api/v1/vouchers/batch-issue`

**New DTO:** `BatchIssueDto`
```typescript
{
  campus_id: number;
  class_id?: number;
  section_id?: number;
  fee_date_from: string;
  fee_date_to: string;
  academic_year?: string;
  bank_account_id: number;
  issue_date: string;
  due_date: string;
  validity_date?: string;
  apply_late_fee: boolean;
  late_fee_amount?: number;
  waive_surcharge?: boolean;
  // Optional overrides per student:
  student_overrides?: {
    cc: number;
    skip: boolean;
  }[];
}
```

**Implementation:** Calls `BulkVoucherJobsService.startJob()` directly (or a new thin wrapper), reusing the entire existing bulk generation pipeline. No new generation logic.

---

### C2 — Frontend Page

**Route:** `tafs-webapp/app/(dashboard)/batch-issue/page.tsx` *(new)*

#### C2.1 — Two-Panel Layout

**Left: Configuration Panel**
- Campus / Class / Section dropdowns
- Fee Date range pickers (from → to)
- Academic Year (auto-computed, editable)
- Bank Account selector
- Issue Date / Due Date / Validity Date pickers
- Late fee toggle + amount
- Waive Surcharge toggle

**Right: Preview Table** (loads after "Preview" button click)

#### C2.2 — Preview Table

Grouped by student. Each student row is expandable:

```
[▼] CC: 1 | John Doe | O-III A       2 voucher groups
    ├── Fee Date: 2026-05-01    [3 heads]  [WILL GENERATE]
    │     - Monthly Tuition Fee (May 2026)   10,000
    │     - Transport Fee (May 2026)          2,500
    │     Total: 12,500
    │
    └── Fee Date: 2026-06-01    [2 heads]  [WILL GENERATE]
          - Monthly Tuition Fee (Jun 2026)   10,000
          Total: 10,000
[▼] CC: 2 | Jane Doe | O-III A       1 voucher group
    └── Fee Date: 2026-05-01    [2 heads]  ⚠ ALREADY ISSUED [SKIP]
```

Each group row shows:
- Fee date
- Number of heads
- Total amount
- Status badge: `WILL GENERATE` (green) / `ALREADY ISSUED` (yellow, auto-skip) / `FULLY PAID` (grey, skip)
- A per-group skip toggle (override auto-skip)

#### C2.3 — Summary Bar

```
Students: 25  |  Voucher Groups: 42  |  Will Generate: 38  |  Skipping: 4  |  Est. Total: PKR 475,000
```

#### C2.4 — Action Buttons

```
[Preview]    [Generate Batch →]    [Export Preview CSV]
```

- **Preview**: Calls `POST /api/v1/vouchers/batch-preview`, populates table
- **Generate Batch**: Shows confirmation modal → calls `POST /api/v1/bulk-voucher-jobs` (existing endpoint) → redirects to `/bulk-voucher` to track progress
- **Export Preview CSV**: Downloads the preview data as CSV without generating anything

#### C2.5 — State Flow

```
IDLE → [Preview Clicked] → LOADING_PREVIEW → PREVIEW_READY
     → [Generate Clicked] → CONFIRM_MODAL → SUBMITTING → DONE (redirect to /bulk-voucher)
```

---

## PART D — Sidebar Navigation Updates

Add entries to the sidebar nav for both new pages:

| Label | Route | Icon | Section |
|---|---|---|---|
| Bulk Delete Vouchers | `/bulk-delete` | `Trash2` | Voucher Management |
| Batch Issue Vouchers | `/batch-issue` | `Layers` | Voucher Management |

---

## Execution Order

| # | Task | Files | Risk | Effort |
|---|---|---|---|---|
| 1 | `bulkRemove()` in `vouchers.service.ts` + DTO + controller endpoint | `vouchers.service.ts`, `vouchers.controller.ts`, new DTO | Low | Low |
| 2 | `/bulk-delete` frontend page | new `page.tsx` | Low | Medium |
| 3 | `batchPreview()` in `vouchers.service.ts` + endpoint | `vouchers.service.ts`, `vouchers.controller.ts`, new DTO | Medium | Medium |
| 4 | `/batch-issue` frontend page | new `page.tsx` | Medium | High |
| 5 | Sidebar nav links for both pages | `layout.tsx` or nav component | Low | Low |
| 6 | Cleanup: remove `createBulk()` / `previewBulk()` legacy methods | `vouchers.service.ts` | Low | Low |
| 7 | Cleanup: replace frontend `FeeChallanPDF.tsx` with iframe | `fee-challan/page.tsx`, delete frontend PDF component | Medium | Low |

> [!IMPORTANT]
> Steps 1 + 2 (Bulk Delete) are self-contained and safe to build first. Steps 3 + 4 (Batch Issue Preview) share backend logic with the existing bulk job pipeline — make sure the WorkItem-building logic is extracted to a shared helper before building the preview endpoint.

> [!WARNING]
> The `batchPreview()` endpoint must read from `student_fees` directly (not from any cached bulk job state). Any student_fees row with status `ISSUED`, `PAID`, or `PARTIALLY_PAID` linked to an existing UNPAID/PAID voucher for that fee_date should be flagged as `already_issued` and auto-skipped, not re-generated.

---

## Decision Needed

1. **Bulk Delete — Hard or Soft?** The existing `remove()` only allows `UNPAID`, `OVERDUE`, or `VOID`. Should the bulk delete page also expose an option to force-delete `PAID` vouchers (with an extra confirmation)? Or strictly follow the same rules?

2. **Batch Issue — Use existing Bulk Job pipeline or new endpoint?** Option A: `batch-issue` creates a proper `bulk_voucher_jobs` DB record and runs async (same as current `/bulk-voucher`). Option B: runs synchronously and returns results inline (works for small batches, no job tracking). Recommendation: **Option A** — redirect to `/bulk-voucher` after submission so the admin can track progress.

3. **Preview endpoint placement** — Should `batchPreview` be a new endpoint on `/vouchers` or should it be part of the existing `/bulk-voucher-jobs/preview`?
