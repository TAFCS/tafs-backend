import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import Piscina from 'piscina';
import {
    resolveVoucherPdfWorkerFilename,
    voucherPdfWorkerCount,
} from './voucher-pdf.pool';
import type { VoucherPdfData } from './voucher-pdf.types';

export type { VoucherPdfData } from './voucher-pdf.types';

@Injectable()
export class VoucherPdfService implements OnModuleDestroy {
    private readonly logger = new Logger(VoucherPdfService.name);
    private readonly pool: Piscina<VoucherPdfData, Uint8Array> | null;

    constructor() {
        const filename = resolveVoucherPdfWorkerFilename(__dirname);
        if (!filename) {
            this.pool = null;
            this.logger.warn(
                'Voucher PDF worker file not found — rendering on the main thread. ' +
                    'This is expected under jest; production must run the compiled dist/ worker.',
            );
            return;
        }

        const maxThreads = voucherPdfWorkerCount();
        this.pool = new Piscina<VoucherPdfData, Uint8Array>({
            filename,
            maxThreads,
            minThreads: Math.min(2, maxThreads),
            concurrentTasksPerWorker: 1,
        });
        this.logger.log(
            `Voucher PDF worker pool ready (${this.pool.minThreads}–${this.pool.maxThreads} threads)`,
        );
    }

    /**
     * Generates a 3-copy (Bank, School, Student) Landscape A4 PDF with a Siblings Info sidebar,
     * utilizing the exact same React Component used on the frontend to ensure 100% visual parity.
     *
     * renderToBuffer is CPU-bound and runs in the Piscina pool so the Nest event
     * loop stays free for other requests. Frozen-PDF downloads never reach here.
     */
    async generateVoucherPdf(data: VoucherPdfData): Promise<Buffer> {
        this.logger.debug(`Generating React-PDF for voucher ${data.voucherNumber} (CC: ${data.student.cc})`);
        try {
            if (this.pool) {
                const bytes = await this.pool.run(data);
                return Buffer.from(bytes);
            }
            const { renderVoucherPdf } = await import('./render-voucher-pdf.js');
            return renderVoucherPdf(data);
        } catch (error) {
            this.logger.error(`Failed to generate React-PDF for ${data.voucherNumber}`, error);
            throw error;
        }
    }

    async mergePdfs(pdfBuffers: Buffer[]): Promise<Buffer> {
        const mergedPdf = await PDFDocument.create();

        for (const buffer of pdfBuffers) {
            const doc = await PDFDocument.load(buffer);
            const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
            copiedPages.forEach((p) => mergedPdf.addPage(p));
        }

        const mergedPdfBytes = await mergedPdf.save();
        return Buffer.from(mergedPdfBytes);
    }

    async onModuleDestroy() {
        if (!this.pool) return;
        await this.pool.destroy();
    }
}
