import { PickType } from '@nestjs/mapped-types';
import { CreateVoucherDto } from './create-voucher.dto';

/**
 * TAFSD-550 (Rule B): Regenerate on a student's latest voucher reissues it with
 * the same settings single issuance on /fee-challan takes. The webapp collects
 * them with the shared VoucherSettingsPanel.
 *
 * Only the issuance settings come from the caller. What is billed (student,
 * class, fee date, heads, academic year, month) is read from the voucher being
 * regenerated, so a regenerate can never bill a different period: that is a
 * new voucher, issued from /fee-challan.
 *
 * Picked from CreateVoucherDto so a setting added there has to be considered
 * here too, with the same validation and coercion.
 */
export class RegenerateVoucherDto extends PickType(CreateVoucherDto, [
    'bank_account_id',
    'issue_date',
    'due_date',
    'validity_date',
    'pay_immediately_custom_dates',
    'is_revised',
    'late_fee_charge',
    'late_fee_amount',
    'reprint_fee_charge',
    'reprint_fee_amount',
    'waive_surcharge',
    'waived_by',
    'send_notification',
    'requires_release',
] as const) {}
