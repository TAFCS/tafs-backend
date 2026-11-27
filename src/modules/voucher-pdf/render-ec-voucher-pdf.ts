import { renderToBuffer } from '@react-pdf/renderer';
import * as React from 'react';
import { EcChallanPDF } from './EcChallanPDF';
import type { EcVoucherPdfData } from './ec-voucher-pdf.types';

/**
 * TAFSD-605: CPU-bound render of the extracurricular challan. Runs in the
 * shared Piscina worker as the named task `renderEcVoucherPdfTask`, or
 * in-process when the compiled worker is missing (jest / ts-node).
 */
export async function renderEcVoucherPdf(data: EcVoucherPdfData): Promise<Buffer> {
    const element = React.createElement(EcChallanPDF, { data }) as any;
    return Buffer.from(await renderToBuffer(element));
}
