import * as os from 'os';
import * as path from 'path';
import {
    VOUCHER_PDF_MAX_WORKERS,
    resolveVoucherPdfWorkerFilename,
    voucherPdfWorkerCount,
} from './voucher-pdf.pool';

describe('voucherPdfWorkerCount', () => {
    it(`caps at ${VOUCHER_PDF_MAX_WORKERS}`, () => {
        const available =
            typeof os.availableParallelism === 'function'
                ? os.availableParallelism()
                : os.cpus().length;
        const n = voucherPdfWorkerCount();
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(VOUCHER_PDF_MAX_WORKERS);
        expect(n).toBe(Math.min(VOUCHER_PDF_MAX_WORKERS, available));
    });
});

describe('resolveVoucherPdfWorkerFilename', () => {
    it('returns null when the compiled worker is missing', () => {
        expect(resolveVoucherPdfWorkerFilename(path.join(__dirname, '__no_such_dir__'))).toBeNull();
    });
});
