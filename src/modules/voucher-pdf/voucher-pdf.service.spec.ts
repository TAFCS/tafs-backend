const run = jest.fn().mockResolvedValue(Uint8Array.from([0x25, 0x50, 0x44, 0x46])); // %PDF
const destroy = jest.fn().mockResolvedValue(undefined);

jest.mock('piscina', () => {
    return class MockPiscina {
        run = run;
        destroy = destroy;
        minThreads: number;
        maxThreads: number;
        constructor(opts: { maxThreads: number; minThreads: number }) {
            this.maxThreads = opts.maxThreads;
            this.minThreads = opts.minThreads;
        }
    };
});

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn((p: string) => String(p).endsWith('voucher-pdf.worker.js')),
}));

import { VoucherPdfService } from './voucher-pdf.service';
import type { VoucherPdfData } from './voucher-pdf.types';

const sample: VoucherPdfData = {
    voucherNumber: '1',
    student: {
        cc: 10,
        classId: 1,
        fullName: 'A',
        fatherName: 'B',
        gender: 'M',
        grNumber: 'G1',
        className: 'I',
        sectionName: 'A',
    },
    campusName: 'Main',
    academicYear: '2026-2027',
    month: 'SEP',
    issueDate: '2026-09-01',
    dueDate: '2026-09-10',
    validityDate: '2026-09-15',
    bank: { name: 'B', title: 'T', account: '1', iban: '', address: '' },
    feeHeads: [],
    totalAmount: 0,
    lateFeeAmount: 0,
    reprintFeeAmount: 0,
};

describe('VoucherPdfService worker pool', () => {
    beforeEach(() => {
        run.mockClear();
        destroy.mockClear();
    });

    it('generateVoucherPdf dispatches to Piscina and returns a Buffer', async () => {
        const service = new VoucherPdfService();
        const buf = await service.generateVoucherPdf(sample);

        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0][0]).toEqual(sample);
        expect(Buffer.isBuffer(buf)).toBe(true);
        expect(buf.toString('ascii', 0, 4)).toBe('%PDF');
        await service.onModuleDestroy();
        expect(destroy).toHaveBeenCalledTimes(1);
    });
});
