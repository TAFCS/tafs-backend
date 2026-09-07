import {
    IsBoolean,
    IsIn,
    IsISO8601,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
} from 'class-validator';
import { Transform } from 'class-transformer';

// ============================================================================
// SHARED VOUCHER-ISSUANCE SETTINGS — KEEP IN SYNC WITH CreateVoucherDto
// ----------------------------------------------------------------------------
// The fields below (bank_account_id, late_fee_charge, late_fee_amount,
// reprint_fee_charge, reprint_fee_amount, waive_surcharge, waived_by,
// send_notification, requires_release) mirror the single-voucher issuance
// contract in `create-voucher.dto.ts`. The webapp renders ONE shared form for
// both flows (`src/features/vouchers/components/VoucherSettingsPanel.tsx`), so
// any field added / renamed / re-typed here MUST be mirrored in:
//   • create-voucher.dto.ts          (single issuance backend contract)
//   • VoucherSettingsPanel.tsx       (shared webapp form + VoucherSettings type)
//   • VouchersService.splitPartiallyPaid()  (applies these to the balance voucher)
//   • VouchersService.create()       (applies these to a fresh voucher)
// Leaving a field unset here = "inherit whatever the original voucher had"
// (the historical split behaviour), NOT the CreateVoucherDto default.
// ============================================================================

export class SplitPartiallyPaidDto {
    @IsISO8601()
    @IsNotEmpty()
    issue_date!: string;

    @IsISO8601()
    @IsNotEmpty()
    due_date!: string;

    @IsISO8601()
    @IsOptional()
    validity_date?: string;

    // Explicit admin override for the fee_date the new "BALANCE PAYMENT OF" head(s)
    // should carry. If omitted (and use_nearest_future_fee_date is false/unset), the
    // balance head keeps its original fee_date — the default, backwards-compatible
    // behavior. (Split-only: /fee-challan has no equivalent.)
    @IsISO8601()
    @IsOptional()
    balance_fee_date?: string;

    // When true, the balance head's fee_date is auto-resolved per fee type to the
    // nearest future fee_date already on the student's schedule (the next
    // NOT_ISSUED/ISSUED student_fees row for the same fee_type_id). Takes
    // precedence over balance_fee_date if both are supplied. Typical use case: an
    // arrear deposit where a small late-payment surcharge is settled now and the
    // remaining balance should roll forward onto the next voucher instead of
    // staying on the (already overdue) original period. (Split-only.)
    @IsBoolean()
    @IsOptional()
    use_nearest_future_fee_date?: boolean;

    // ── Shared issuance settings (see banner above) ─────────────────────────
    // All optional. Unset = inherit the original voucher's value.

    // Collection bank for the balance voucher. Unset = original.bank_account_id.
    @Transform(({ value }) =>
        value === undefined || value === null || value === '' ? undefined : Number(value),
    )
    @IsNumber()
    @IsOptional()
    bank_account_id?: number;

    // Whether the due-date late fee applies to the balance voucher.
    // Unset = original.late_fee_charge.
    @Transform(({ value }) =>
        value === undefined || value === null || value === ''
            ? undefined
            : value === 'true' || value === true,
    )
    @IsBoolean()
    @IsOptional()
    late_fee_charge?: boolean;

    // Due-date late fee amount. Unset = 1000 (historical split constant).
    @Transform(({ value }) =>
        value === undefined || value === null || value === '' ? undefined : Number(value),
    )
    @IsNumber()
    @IsOptional()
    late_fee_amount?: number;

    // Admin-added reprint fee on the balance voucher. Unset/false = none.
    @Transform(({ value }) =>
        value === undefined || value === null || value === ''
            ? undefined
            : value === 'true' || value === true,
    )
    @IsBoolean()
    @IsOptional()
    reprint_fee_charge?: boolean;

    @Transform(({ value }) =>
        value === undefined || value === null || value === '' ? undefined : Number(value),
    )
    @IsNumber()
    @IsOptional()
    reprint_fee_amount?: number;

    // When true, every arrear late-payment surcharge row that lands on the balance
    // voucher is marked waived (amount forgiven, excluded from payable totals).
    // Mirrors CreateVoucherDto.waive_surcharge. The split does NOT recompute /
    // drop surcharges — the admin manages stale ones via deposit allocation and
    // this lever. Unset/false = keep whatever the original voucher's surcharge
    // rows carried.
    @Transform(({ value }) =>
        value === undefined || value === null || value === ''
            ? undefined
            : value === 'true' || value === true,
    )
    @IsBoolean()
    @IsOptional()
    waive_surcharge?: boolean;

    @IsString()
    @IsOptional()
    waived_by?: string;

    // Instant "voucher issued" push to the family when the balance voucher is
    // released. Only meaningful when the balance voucher is actually issued and
    // released (see balance_disposition). Unset = do not fire an instant push
    // (historical split behaviour — the split never notified).
    @Transform(({ value }) =>
        value === undefined || value === null || value === ''
            ? undefined
            : value === 'true' || value === true,
    )
    @IsBoolean()
    @IsOptional()
    send_notification?: boolean;

    // When true, the balance voucher is created held (`released_to_parent_at`
    // stays null): invisible to parents and silent until an admin with
    // finance.vouchers.release releases it via the Pending Release page.
    // Redundant with balance_disposition === 'ISSUE_AND_HOLD'; kept for parity
    // with CreateVoucherDto. Unset = not held.
    @Transform(({ value }) =>
        value === undefined || value === null || value === ''
            ? undefined
            : value === 'true' || value === true,
    )
    @IsBoolean()
    @IsOptional()
    requires_release?: boolean;

    // What to do with the balance (unpaid) half of the split:
    //   ISSUE_AND_NOTIFY  — create it, visible to parents, fire the issued push  (default)
    //   ISSUE_AND_RELEASE — create it, visible to parents, no push
    //   ISSUE_AND_HOLD    — create it held for release (Pending Release page); push fires on release
    //   DO_NOT_ISSUE      — run the full split but do NOT create the balance voucher;
    //                       leave the balance student_fees rows NOT_ISSUED for a later run
    @IsIn(['ISSUE_AND_NOTIFY', 'ISSUE_AND_RELEASE', 'ISSUE_AND_HOLD', 'DO_NOT_ISSUE'])
    @IsOptional()
    balance_disposition?:
        | 'ISSUE_AND_NOTIFY'
        | 'ISSUE_AND_RELEASE'
        | 'ISSUE_AND_HOLD'
        | 'DO_NOT_ISSUE';
}
