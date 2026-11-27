jest.mock('../../voucher-pdf/voucher-pdf.service');

import { EcVoucherPdfService, ecMonthsLabel } from './ec-voucher-pdf.service';

/**
 * TAFSD-605: the extracurricular challan cache. A frozen paid receipt is never
 * re-rendered, an unchanged unpaid challan is served from storage, and a
 * changed one is rendered once under a new hashed key.
 */

const voucherRow = (over: Record<string, unknown> = {}) => ({
    id: 5,
    voucher_number: 'EC1126000005',
    student_id: 9001,
    academic_year: '2026-2027',
    issue_date: new Date('2026-11-27T00:00:00Z'),
    expiry_date: new Date('2099-12-12T00:00:00Z'),
    status: 'UNPAID',
    total_amount: 2500,
    amount_paid: 0,
    amount_waived: 0,
    bank_snapshot: { id: 1, name: 'Test Bank', title: 'TAFS', account: '0000', iban: '', address: '' },
    generated_by_name: 'clerk',
    created_at: new Date('2026-11-27T05:00:00Z'),
    pdf_url: null,
    pdf_hash: null,
    paid_pdf_url: null,
    paid_pdf_filename: null,
    reissued_to: null,
    campuses: { campus_name: 'Campus A' },
    classes: { class_code: 'VI', description: 'Class VI' },
    sections: { description: 'A' },
    ec_voucher_lines: [{ description: 'SWIMMING (SEP 26)', amount: 2500, ec_student_charges: { period: new Date('2026-09-01T00:00:00Z') } }],
    students: { cc: 9001, full_name: 'Test', gr_number: 'GR-1', gender: 'F', family_id: null, houses: null, student_guardians: [] },
    ...over,
});

function setup(row: ReturnType<typeof voucherRow>) {
    const prisma = {
        ec_vouchers: {
            findUniqueOrThrow: jest.fn().mockResolvedValue(row),
            findUnique: jest.fn().mockResolvedValue({ paid_pdf_url: 'https://cdn/won-by-other.pdf', paid_pdf_filename: 'other.pdf' }),
            findMany: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        ec_deposits: { findMany: jest.fn().mockResolvedValue([]) },
        students: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const storage = {
        getPublicUrl: jest.fn((k: string) => `https://cdn/${k}`),
        upload: jest.fn((k: string) => Promise.resolve(`https://cdn/${k}`)),
        deleteByUrl: jest.fn().mockResolvedValue(undefined),
        getFile: jest.fn(),
        extractKeyFromUrl: jest.fn((u: string) => u.replace('https://cdn/', '')),
    };
    const pdf = { generateEcVoucherPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')), mergePdfs: jest.fn() };
    const service = new EcVoucherPdfService(prisma as any, storage as any, pdf as any);
    return { service, prisma, storage, pdf };
}

describe('EC challan cache (TAFSD-605)', () => {
    it('labels consecutive months as a range, others as a list', () => {
        const d = (s: string) => new Date(`${s}T00:00:00Z`);
        expect(ecMonthsLabel([d('2026-09-01'), d('2026-11-01'), d('2026-10-01')])).toBe('SEP 26 - NOV 26');
        expect(ecMonthsLabel([d('2026-09-01'), d('2026-12-01')])).toBe('SEP 26, DEC 26');
        expect(ecMonthsLabel([d('2026-12-01'), d('2027-01-01')])).toBe('DEC 26 - JAN 27');
        expect(ecMonthsLabel([d('2026-09-01'), d('2026-09-01')])).toBe('SEP 26');
    });

    it('renders an uncached challan once and remembers its hash', async () => {
        const { service, prisma, storage, pdf } = setup(voucherRow());
        const res = await service.ensurePdf(5);
        expect(pdf.generateEcVoucherPdf).toHaveBeenCalledTimes(1);
        const [data] = pdf.generateEcVoucherPdf.mock.calls[0];
        expect(data.qrUrl).toBe(res.url);
        expect(res.url).toMatch(/^https:\/\/cdn\/ec-vouchers\/9001\/GR-1_EC1126000005_[0-9a-f]{8}\.pdf$/);
        expect(res.filename).toBe('GR-1_EC1126000005.pdf');
        expect(storage.upload).toHaveBeenCalledTimes(1);
        expect(prisma.ec_vouchers.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { pdf_url: res.url, pdf_hash: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    });

    it('serves an unchanged challan from storage without rendering', async () => {
        const first = setup(voucherRow());
        const { data } = await first.service.buildData(5);
        const hash = first.service.hashOf(data);
        const { service, pdf } = setup(voucherRow({ pdf_url: 'https://cdn/cached.pdf', pdf_hash: hash }));
        expect(await service.ensurePdf(5)).toEqual({ url: 'https://cdn/cached.pdf', filename: 'GR-1_EC1126000005.pdf' });
        expect(pdf.generateEcVoucherPdf).not.toHaveBeenCalled();
    });

    it('never hashes the QR url, and is blind to key order', async () => {
        const { service } = setup(voucherRow());
        const { data } = await service.buildData(5);
        const reordered = Object.fromEntries(Object.entries(data).reverse()) as typeof data;
        expect(service.hashOf({ ...data, qrUrl: 'https://x' })).toBe(service.hashOf(reordered));
        expect(service.hashOf({ ...data, totalAmount: 1 })).not.toBe(service.hashOf(data));
    });

    it('returns a frozen paid receipt without rendering', async () => {
        const { service, pdf } = setup(voucherRow({ status: 'PAID', amount_paid: 2500, paid_pdf_url: 'https://cdn/frozen.pdf', paid_pdf_filename: 'GR-1_EC1126000005_paid.pdf' }));
        expect(await service.ensurePdf(5)).toEqual({ url: 'https://cdn/frozen.pdf', filename: 'GR-1_EC1126000005_paid.pdf' });
        expect(pdf.generateEcVoucherPdf).not.toHaveBeenCalled();
    });

    it('freezes the paid receipt once, stamped PAID, and yields to a writer that got there first', async () => {
        const { service, prisma, pdf } = setup(voucherRow({ status: 'PAID', amount_paid: 2500 }));
        const res = await service.ensurePdf(5);
        expect(pdf.generateEcVoucherPdf.mock.calls[0][0].stamp).toBe('PAID');
        expect(prisma.ec_vouchers.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 5, paid_pdf_url: null, status: 'PAID' } }),
        );
        expect(res.url).toMatch(/_paid\.pdf$/);

        const raced = setup(voucherRow({ status: 'PAID', amount_paid: 2500 }));
        raced.prisma.ec_vouchers.updateMany.mockResolvedValue({ count: 0 });
        expect(await raced.service.ensurePdf(5)).toEqual({ url: 'https://cdn/won-by-other.pdf', filename: 'other.pdf' });
    });

    it('stamps an expired or reissued challan EXPIRED', async () => {
        const { service } = setup(voucherRow({ expiry_date: new Date('2020-01-01T00:00:00Z') }));
        expect((await service.buildData(5)).data.stamp).toBe('EXPIRED');
        const reissued = setup(voucherRow({ expiry_date: new Date('2020-01-01T00:00:00Z'), reissued_to: { id: 6 } }));
        expect((await reissued.service.buildData(5)).data.stamp).toBe('EXPIRED');
    });
});
