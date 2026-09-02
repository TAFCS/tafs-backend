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
 * dist/; jest / ts-node run from .ts and have no sibling worker.js.
 */
export function resolveVoucherPdfWorkerFilename(dirname: string): string | null {
    const compiled = path.join(dirname, 'voucher-pdf.worker.js');
    return fs.existsSync(compiled) ? compiled : null;
}
