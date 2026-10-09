import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Cap so a 32-core box does not spawn 32 copies of yoga + FeeChallanPDF. */
export const VOUCHER_PDF_MAX_WORKERS = 8;

export function voucherPdfWorkerCount(): number {
    const available =
        typeof os.availableParallelism === 'function'
            ? os.availableParallelism()
            : os.cpus().length;
    return Math.max(1, Math.min(VOUCHER_PDF_MAX_WORKERS, available));
}

/**
 * Piscina needs a compiled .js file. Nest emits this next to the service in
 * dist/; jest / ts-node run from .ts and have no sibling worker.js. When ops
 * scripts boot AppModule via ts-node after `npm run build`, fall back to the
 * dist/ worker so remints (e.g. TAFSD-286) do not hit the broken main-thread
 * `import('./render-voucher-pdf.js')` path.
 */
export function resolveVoucherPdfWorkerFilename(dirname: string): string | null {
    const candidates = [
        path.join(dirname, 'voucher-pdf.worker.js'),
        // nest build emits under dist/src/… (rootDir = project root / src nesting).
        path.join(process.cwd(), 'dist/src/modules/voucher-pdf/voucher-pdf.worker.js'),
        path.join(process.cwd(), 'dist/modules/voucher-pdf/voucher-pdf.worker.js'),
    ];
    for (const compiled of candidates) {
        if (fs.existsSync(compiled)) return compiled;
    }
    return null;
}
