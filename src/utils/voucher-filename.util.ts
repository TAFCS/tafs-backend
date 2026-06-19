/**
 * Centralized voucher PDF filename convention, mirrored from the frontend
 * (tafs-webapp/src/lib/voucher-filename.ts) for places where the backend
 * names individual voucher files for the user (e.g. zip entries).
 *
 * Format: grnumber_feedate_vouchernumber.pdf
 */
export function buildVoucherFilename(params: {
    grNumber?: string | null;
    cc?: number | string | null;
    studentId?: number | string | null;
    feeDate?: string | Date | null;
    voucherId: number | string;
    suffix?: string;
}): string {
    const { grNumber, cc, studentId, feeDate, voucherId, suffix } = params;

    const gr =
        grNumber ||
        (cc != null ? `CC${cc}` : studentId != null ? `CC${studentId}` : `CC${voucherId}`);

    const feeDateStr = feeDate
        ? (feeDate instanceof Date ? feeDate.toISOString() : String(feeDate)).slice(0, 10)
        : 'unknown';

    const base = `${gr}_${feeDateStr}_${voucherId}`;
    return suffix ? `${base}_${suffix}.pdf` : `${base}.pdf`;
}
