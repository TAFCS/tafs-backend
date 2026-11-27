import { renderVoucherPdf } from './render-voucher-pdf';
import type { VoucherPdfData } from './voucher-pdf.types';
import type { EcVoucherPdfData } from './ec-voucher-pdf.types';

/**
 * Piscina worker entry. Default export is the task function.
 * Returns a copy of the PDF bytes so the ArrayBuffer is not a slice of a
 * larger Buffer pool.
 */
export default async function renderVoucherPdfTask(data: VoucherPdfData): Promise<Uint8Array> {
    const buffer = await renderVoucherPdf(data);
    return new Uint8Array(buffer);
}

/**
 * TAFSD-605: the extracurricular challan, run as a named task
 * (`pool.run(data, { name: 'renderEcVoucherPdfTask' })`) on the same threads.
 * Loaded lazily so the academic task above starts exactly as before.
 */
export async function renderEcVoucherPdfTask(data: EcVoucherPdfData): Promise<Uint8Array> {
    const { renderEcVoucherPdf } = await import('./render-ec-voucher-pdf.js');
    return new Uint8Array(await renderEcVoucherPdf(data));
}
