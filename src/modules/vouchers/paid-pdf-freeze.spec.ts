// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary —
// these tests inject their own pdfService double anyway.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { VouchersService } from './vouchers.service';
import { PassThrough } from 'stream';

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

describe('VouchersService unpaid PDF freeze', () => {
  const unpaidRow = {
    id: 20,
    student_id: 5,
    status: 'UNPAID',
    pdf_url: 'https://cdn/vouchers/5/GR123_2026-01-01_20.pdf',
    paid_pdf_url: null,
    paid_pdf_filename: null,
    fee_date: new Date('2026-01-01T00:00:00.000Z'),
    students: { gr_number: 'GR123' },
  };

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
      generateVoucherPdf: jest.fn().mockResolvedValue(Buffer.from('rendered')),
    };
    const voucherNotificationService: any = {
      sendVoucherIssuedNotification: jest.fn().mockResolvedValue(null),
    };
    const service = new VouchersService(
      prisma,
      storage,
      pdfService,
      {} as any,
      {} as any,
      voucherNotificationService,
    );
    return { service, prisma, storage, pdfService, voucherNotificationService };
  };

  it('generatePdf with pdf_url set and no force returns stored URL without render/upload/update', async () => {
    const { service, prisma, storage, pdfService } = build(unpaidRow);

    const result = await service.generatePdf(20);

    expect(result).toEqual({
      pdf_url: unpaidRow.pdf_url,
      filename: 'GR123_2026-01-01_20.pdf',
      frozen: true,
    });
    expect(pdfService.generateVoucherPdf).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.vouchers.update).not.toHaveBeenCalled();
    expect(prisma.vouchers.findUnique.mock.calls[0][0].include).toBeUndefined();
    expect(prisma.vouchers.findUnique.mock.calls[0][0].select).toEqual(
      expect.objectContaining({ pdf_url: true, paid_pdf_url: true }),
    );
  });

  it('generatePdf with force: true renders, uploads, and persists', async () => {
    const { service, prisma, storage, pdfService } = build(unpaidRow);
    jest.spyOn(service as any, 'prepareVoucherPdfData').mockResolvedValue({
      voucherData: {},
      key: 'vouchers/5/GR123_2026-01-01_20.pdf',
      filename: 'GR123_2026-01-01_20.pdf',
    });
    jest.spyOn(service as any, 'ensureVoucherGenerationMeta').mockResolvedValue(undefined);

    const result = await service.generatePdf(20, true, false, 'Someone', { force: true });

    expect(result.frozen).toBe(false);
    expect(result.pdf_url).toBe('https://cdn/uploaded.pdf');
    expect(pdfService.generateVoucherPdf).toHaveBeenCalled();
    expect(storage.upload).toHaveBeenCalled();
    expect(prisma.vouchers.update).toHaveBeenCalledWith({
      where: { id: 20 },
      data: { pdf_url: 'https://cdn/uploaded.pdf' },
    });
  });

  it('regenerate with requires_release holds the voucher and does not notify', async () => {
    const { service, prisma, pdfService, voucherNotificationService } = build(unpaidRow);
    jest.spyOn(service as any, 'prepareVoucherPdfData').mockResolvedValue({
      voucherData: {},
      key: 'vouchers/5/GR123_2026-01-01_20.pdf',
      filename: 'GR123_2026-01-01_20.pdf',
    });
    jest.spyOn(service as any, 'ensureVoucherGenerationMeta').mockResolvedValue(undefined);

    await service.generatePdf(20, true, false, 'Someone', {
      force: true,
      requires_release: true,
      send_notification: true,
    });

    expect(pdfService.generateVoucherPdf).toHaveBeenCalled();
    expect(prisma.vouchers.update).toHaveBeenCalledWith({
      where: { id: 20 },
      data: {
        pdf_url: 'https://cdn/uploaded.pdf',
        released_to_parent_at: null,
        released_by: null,
      },
    });
    expect(voucherNotificationService.sendVoucherIssuedNotification).not.toHaveBeenCalled();
  });

  it('regenerate with release + notify sends the issued notification', async () => {
    const { service, prisma, voucherNotificationService } = build(unpaidRow);
    jest.spyOn(service as any, 'prepareVoucherPdfData').mockResolvedValue({
      voucherData: {},
      key: 'vouchers/5/GR123_2026-01-01_20.pdf',
      filename: 'GR123_2026-01-01_20.pdf',
    });
    jest.spyOn(service as any, 'ensureVoucherGenerationMeta').mockResolvedValue(undefined);

    await service.generatePdf(20, true, false, 'Someone', {
      force: true,
      requires_release: false,
      send_notification: true,
      releasedBy: 'admin',
    });

    expect(prisma.vouchers.update).toHaveBeenCalledWith({
      where: { id: 20 },
      data: expect.objectContaining({
        pdf_url: 'https://cdn/uploaded.pdf',
        released_by: 'admin',
      }),
    });
    const patch = prisma.vouchers.update.mock.calls[0][0].data;
    expect(patch.released_to_parent_at).toBeInstanceOf(Date);
    expect(voucherNotificationService.sendVoucherIssuedNotification).toHaveBeenCalledWith(20);
  });

  it('generatePdf with pdf_url null renders', async () => {
    const { service, pdfService } = build({ ...unpaidRow, pdf_url: null });
    jest.spyOn(service as any, 'prepareVoucherPdfData').mockResolvedValue({
      voucherData: {},
      key: 'vouchers/5/GR123_2026-01-01_20.pdf',
      filename: 'GR123_2026-01-01_20.pdf',
    });
    jest.spyOn(service as any, 'ensureVoucherGenerationMeta').mockResolvedValue(undefined);

    const result = await service.generatePdf(20);

    expect(result.frozen).toBe(false);
    expect(pdfService.generateVoucherPdf).toHaveBeenCalled();
  });

  it('generatePdf PAID + paid_pdf_url + force: true still returns frozen, no render', async () => {
    const { service, pdfService, storage, prisma } = build({
      id: 21,
      status: 'PAID',
      paid_pdf_url: 'https://cdn/vouchers/5/GR123_2026-01-01_21_paid.pdf',
      paid_pdf_filename: 'GR123_2026-01-01_21_paid.pdf',
      pdf_url: 'https://cdn/vouchers/5/GR123_2026-01-01_21.pdf',
    });

    const result = await service.generatePdf(21, true, true, 'Someone', { force: true });

    expect(result).toEqual({
      pdf_url: 'https://cdn/vouchers/5/GR123_2026-01-01_21_paid.pdf',
      filename: 'GR123_2026-01-01_21_paid.pdf',
      frozen: true,
    });
    expect(pdfService.generateVoucherPdf).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.vouchers.update).not.toHaveBeenCalled();
  });

  it('generatePdfBuffer with pdf_url set fetches stored bytes, no render/upload', async () => {
    const { service, storage, pdfService, prisma } = build(unpaidRow);

    const result = await service.generatePdfBuffer(20);

    expect(result.url).toBe(unpaidRow.pdf_url);
    expect(result.filename).toBe('GR123_2026-01-01_20.pdf');
    expect(result.buffer.toString()).toBe('stored-pdf');
    expect(storage.getFile).toHaveBeenCalled();
    expect(pdfService.generateVoucherPdf).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.vouchers.update).not.toHaveBeenCalled();
    expect(prisma.vouchers.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.vouchers.findUnique.mock.calls[0][0].include).toBeUndefined();
  });

  it('generatePdfBuffer falls through to render when getFile throws', async () => {
    const { service, storage, pdfService } = build(unpaidRow);
    storage.getFile.mockRejectedValue(new Error('NoSuchKey'));
    jest.spyOn(service as any, 'prepareVoucherPdfData').mockResolvedValue({
      voucherData: {},
      key: 'vouchers/5/GR123_2026-01-01_20.pdf',
      filename: 'GR123_2026-01-01_20.pdf',
    });
    jest.spyOn(service as any, 'ensureVoucherGenerationMeta').mockResolvedValue(undefined);

    const result = await service.generatePdfBuffer(20);

    expect(pdfService.generateVoucherPdf).toHaveBeenCalled();
    expect(storage.upload).toHaveBeenCalled();
    expect(result.filename).toBe('GR123_2026-01-01_20.pdf');
    expect(result.url).toBe('https://cdn/uploaded.pdf');
  });

  it('generatePdfBuffer for PAID without paid_pdf_url does not serve unpaid pdf_url', async () => {
    const { service, storage, pdfService } = build({
      ...unpaidRow,
      id: 22,
      status: 'PAID',
      paid_pdf_url: null,
      paid_pdf_filename: null,
      pdf_url: 'https://cdn/vouchers/5/GR123_2026-01-01_22.pdf',
    });
    jest.spyOn(service as any, 'prepareVoucherPdfData').mockResolvedValue({
      voucherData: {},
      key: 'vouchers/5/GR123_2026-01-01_22_paid.pdf',
      filename: 'GR123_2026-01-01_22_paid.pdf',
    });
    jest.spyOn(service as any, 'ensureVoucherGenerationMeta').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'freezePaidPdf').mockResolvedValue({
      pdf_url: 'https://cdn/uploaded.pdf',
      filename: 'GR123_2026-01-01_22_paid.pdf',
    });

    await service.generatePdfBuffer(22);

    expect(storage.getFile).not.toHaveBeenCalled();
    expect(pdfService.generateVoucherPdf).toHaveBeenCalled();
  });

  it('batchExport of frozen unpaid PDFs fetches stored bytes and does not render', async () => {
    const rowA = { ...unpaidRow, id: 30 };
    const rowB = {
      ...unpaidRow,
      id: 31,
      pdf_url: 'https://cdn/vouchers/5/GR123_2026-01-01_31.pdf',
    };
    const { service, prisma, storage, pdfService } = build(rowA);
    prisma.vouchers.findMany.mockResolvedValue([rowA, rowB]);

    const res = new PassThrough();
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    const finished = new Promise<void>((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
    });

    await service.batchExport([30, 31], undefined, res as any);
    await finished;

    expect(pdfService.generateVoucherPdf).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.getFile).toHaveBeenCalledTimes(2);
    expect(prisma.vouchers.findMany).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(chunks).length).toBeGreaterThan(22); // zip local file header
  });
});
