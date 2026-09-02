import { renderVoucherPdf } from './render-voucher-pdf';
import type { VoucherPdfData } from './voucher-pdf.types';

/**
 * Piscina worker entry. Default export is the task function.
 * Returns a copy of the PDF bytes so the ArrayBuffer is not a slice of a
 * larger Buffer pool.
 */
export default async function renderVoucherPdfTask(data: VoucherPdfData): Promise<Uint8Array> {
    const buffer = await renderVoucherPdf(data);
    return new Uint8Array(buffer);
}
