import * as fs from 'fs';
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
    const cwd = process.cwd();

    afterEach(() => {
        process.chdir(cwd);
    });

    it('returns null when neither sibling nor dist/ worker exists', () => {
        // Isolate from a local `npm run build` that left dist/ populated.
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'voucher-pdf-pool-'));
        process.chdir(empty);
        expect(resolveVoucherPdfWorkerFilename(path.join(empty, '__no_such_dir__'))).toBeNull();
    });

    it('falls back to dist/ when the sibling worker is missing but dist is built', () => {
        const distWorkers = [
            path.join(cwd, 'dist/src/modules/voucher-pdf/voucher-pdf.worker.js'),
            path.join(cwd, 'dist/modules/voucher-pdf/voucher-pdf.worker.js'),
        ];
        const existing = distWorkers.find((p) => fs.existsSync(p));
        const resolved = resolveVoucherPdfWorkerFilename(path.join(__dirname, '__no_such_dir__'));
        if (existing) {
            expect(resolved).toBe(existing);
        } else {
            expect(resolved).toBeNull();
        }
    });
});
