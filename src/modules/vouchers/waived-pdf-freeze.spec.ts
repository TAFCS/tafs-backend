// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary —
// these tests inject their own pdfService double anyway.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { VouchersService } from './vouchers.service';

/**
 * The frozen WAIVED challan contract — the exact mirror of the frozen PAID
 * receipt (see paid-pdf-freeze.spec.ts). A waived challan documents a write-off
 * decision, so once vouchers.waived_pdf_url is set, asking for it again returns
 * the stored object with no re-render and no re-upload.
 *
 * The two artifacts must never collide: a PAID receipt, a WAIVED challan and the
 * plain ISSUED challan are three distinct storage objects under three distinct
 * keys, tracked in three distinct columns.
 */
describe('VouchersService waived PDF freeze', () => {
  const build = (voucherRow: any) => {
    const prisma: any = {
      vouchers: {
        findUnique: jest.fn().mockResolvedValue(voucherRow),
        findFirst: jest.fn().mockResolvedValue(voucherRow),
        findMany: jest.fn().mockResolvedValue([voucherRow]),
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
      extractKeyFromUrl: jest.fn((url: string) => url.replace('https://cdn/', '')),
      getFile: jest.fn().mockResolvedValue({ buffer: Buffer.from('stored-pdf'), mime: 'application/pdf' }),
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

  it('returns the frozen WAIVED challan without rendering or uploading', async () => {
    const { service, prisma, storage, pdfService } = build({
      id: 11,
      status: 'WAIVED',
      pdf_url: 'https://cdn/vouchers/5/GR-OLD_2026-01-01_11.pdf',
      waived_pdf_url: 'https://cdn/vouchers/5/GR-OLD_2026-01-01_11_waived.pdf',
      waived_pdf_filename: 'GR-OLD_2026-01-01_11_waived.pdf',
    });

    const result = await service.generatePdf(11, true, false, 'Someone');

    expect(result).toEqual({
      pdf_url: 'https://cdn/vouchers/5/GR-OLD_2026-01-01_11_waived.pdf',
      filename: 'GR-OLD_2026-01-01_11_waived.pdf',
      frozen: true,
    });
    expect(pdfService.generateVoucherPdf).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.vouchers.update).not.toHaveBeenCalled();
  });

  it('never serves the ISSUED challan cache for a WAIVED voucher', async () => {
    // pdf_url is still populated (waiveVoucher deliberately leaves it alone so
    // un-waiving restores the original challan), but it must stay dormant: an
    // un-stamped challan can never be handed out for a written-off voucher.
    const { service } = build({
      id: 12,
      status: 'WAIVED',
      pdf_url: 'https://cdn/vouchers/5/GR-OLD_2026-01-01_12.pdf',
      waived_pdf_url: 'https://cdn/vouchers/5/GR-OLD_2026-01-01_12_waived.pdf',
      waived_pdf_filename: 'GR-OLD_2026-01-01_12_waived.pdf',
    });

    const result = await service.generatePdf(12, true, false, 'Someone');

    expect(result.pdf_url).toBe('https://cdn/vouchers/5/GR-OLD_2026-01-01_12_waived.pdf');
    expect(result.pdf_url).not.toBe('https://cdn/vouchers/5/GR-OLD_2026-01-01_12.pdf');
  });

  it('does not short-circuit when the waived challan has not been minted yet', async () => {
    // waived_pdf_url null => must fall through to the render path rather than
    // returning the stale ISSUED challan sitting in pdf_url.
    const { service } = build({
      id: 13,
      status: 'WAIVED',
      pdf_url: 'https://cdn/vouchers/5/GR-OLD_2026-01-01_13.pdf',
      waived_pdf_url: null,
      waived_pdf_filename: null,
      students: { gr_number: 'GR-NEW' },
    });

    // The render path needs the full VOUCHER_INCLUDE row, which this thin double
    // does not provide; reaching it at all (rather than returning frozen: true)
    // is the assertion. Any throw here is from prepareVoucherPdfData, not from
    // the freeze short-circuit.
    await expect(service.generatePdf(13, true, false, 'Someone')).rejects.toBeDefined();
  });

  it('a PAID voucher still uses paid_pdf_url, not waived_pdf_url', async () => {
    const { service } = build({
      id: 14,
      status: 'PAID',
      pdf_url: 'https://cdn/vouchers/5/GR-OLD_2026-01-01_14.pdf',
      paid_pdf_url: 'https://cdn/vouchers/5/GR-OLD_2026-01-01_14_paid.pdf',
      paid_pdf_filename: 'GR-OLD_2026-01-01_14_paid.pdf',
      waived_pdf_url: 'https://cdn/vouchers/5/GR-OLD_2026-01-01_14_waived.pdf',
      waived_pdf_filename: 'GR-OLD_2026-01-01_14_waived.pdf',
    });

    const result = await service.generatePdf(14, true, true, 'Someone');

    expect(result.pdf_url).toBe('https://cdn/vouchers/5/GR-OLD_2026-01-01_14_paid.pdf');
  });
});
