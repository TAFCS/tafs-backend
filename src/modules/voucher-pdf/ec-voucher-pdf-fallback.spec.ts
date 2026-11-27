// TAFSD-605: with no compiled worker (jest, ts-node, the CI DB job) the
// extracurricular challan renders in-process. It used to do that through a
// dynamic import(), which throws under Jest and failed the DB suite.
jest.mock('./voucher-pdf.pool', () => ({
    resolveVoucherPdfWorkerFilename: () => null,
    voucherPdfWorkerCount: () => 1,
}));

import { VoucherPdfService } from './voucher-pdf.service';

describe('VoucherPdfService without a worker file', () => {
    it('renders an extracurricular challan in-process', async () => {
        const service = new VoucherPdfService();
        const buf = await service.generateEcVoucherPdf({
            voucherNumber: 'EC1126000001',
            lines: [],
            otherOpenVouchers: [],
            payments: [],
            siblings: [],
        } as any);
        expect(Buffer.isBuffer(buf)).toBe(true);
        await service.onModuleDestroy();
    });
});
