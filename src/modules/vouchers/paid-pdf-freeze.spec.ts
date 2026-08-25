// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary —
// these tests inject their own pdfService double anyway.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { VouchersService } from './vouchers.service';

/**
 * The frozen PAID receipt contract: once vouchers.paid_pdf_url is set, asking
 * for the paid PDF again must return the stored object without re-rendering or
 * re-uploading — that is what keeps the filename stable when a student's
 * gr_number is corrected after the receipt was issued.
 */
describe('VouchersService paid PDF freeze', () => {
  const build = (voucherRow: any) => {
    const prisma: any = {
      vouchers: {
        findUnique: jest.fn().mockResolvedValue(voucherRow),
        findFirst: jest.fn().mockResolvedValue(voucherRow),
        update: jest.fn().mockResolvedValue(voucherRow),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      students: {
        findFirst: jest.fn().mockResolvedValue({ cc: 123 }),
      },
    };
    const storage: any = {
      upload: jest.fn().mockResolvedValue('https://cdn/uploaded.pdf'),
      getPublicUrl: jest.fn((k: string) => `https://cdn/${k}`),
    };
    const pdfService: any = {
      generateVoucherPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
    };

    const service = new VouchersService(
      prisma,
      storage,
      pdfService,
      {} as any,
      {} as any,
      {} as any,
    );

    return { service, prisma, storage, pdfService };
  };

  it('returns the frozen receipt without rendering or uploading', async () => {
    const { service, prisma, storage, pdfService } = build({
      id: 7,
      status: 'PAID',
      paid_pdf_url: 'https://cdn/vouchers/5/GR-OLD_2026-01-01_7_paid.pdf',
      paid_pdf_filename: 'GR-OLD_2026-01-01_7_paid.pdf',
    });

    const result = await service.generatePdf(7, true, true, 'Someone');

    expect(result).toEqual({
      pdf_url: 'https://cdn/vouchers/5/GR-OLD_2026-01-01_7_paid.pdf',
      filename: 'GR-OLD_2026-01-01_7_paid.pdf',
      frozen: true,
    });
    // The whole point: no re-render, no re-upload, no DB write.
    expect(pdfService.generateVoucherPdf).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.vouchers.update).not.toHaveBeenCalled();
  });

  it('short-circuits a PAID voucher even when paid_stamp was not requested', async () => {
    const { service, pdfService } = build({
      id: 9,
      status: 'PAID',
      paid_pdf_url: 'https://cdn/vouchers/5/GR-OLD_2026-01-01_9_paid.pdf',
      paid_pdf_filename: 'GR-OLD_2026-01-01_9_paid.pdf',
    });

    // paidStamp=false, but status PAID forces finalPaidStamp — so the frozen
    // receipt must still win.
    const result = await service.generatePdf(9, true, false);

    expect((result as any).frozen).toBe(true);
    expect(pdfService.generateVoucherPdf).not.toHaveBeenCalled();
  });

  it('ignores paid_stamp: true for non-PAID vouchers and does not freeze receipt', async () => {
    const { service, prisma, storage, pdfService } = build({
      id: 10,
      status: 'UNPAID',
      paid_pdf_url: null,
      paid_pdf_filename: null,
      issue_date: new Date(),
      due_date: new Date(),
      validity_date: new Date(),
      fee_date: new Date(),
      students: { id: 1, gr_number: 'GR123', name: 'Student' },
      voucher_heads: [],
    });

    jest.spyOn(service as any, 'prepareVoucherPdfData').mockResolvedValue({
      voucherData: {},
      key: 'vouchers/1/GR123.pdf',
      filename: 'GR123.pdf',
    });
    jest.spyOn(service as any, 'ensureVoucherGenerationMeta').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'freezePaidPdf').mockResolvedValue({});

    const result = await service.generatePdf(10, true, true, 'Someone');

    expect(result.frozen).toBe(false);
    expect((service as any).freezePaidPdf).not.toHaveBeenCalled();
    expect(prisma.vouchers.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { pdf_url: 'https://cdn/uploaded.pdf' },
    });
  });

  it('ensurePaidPdfForParent throws BadRequestException for non-PAID vouchers even if paid_pdf_url exists', async () => {
    const { service } = build({
      id: 11,
      status: 'UNPAID',
      paid_pdf_url: 'https://cdn/stale_paid.pdf',
    });

    await expect(service.ensurePaidPdfForParent(11, 123, 456)).rejects.toThrow(
      'This challan is not marked paid yet.',
    );
  });
});
