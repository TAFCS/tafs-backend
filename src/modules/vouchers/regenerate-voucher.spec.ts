// @react-pdf/renderer ships ESM that jest's CJS transform can't load, and it is
// pulled in transitively via VoucherPdfService. Stub that module boundary.
jest.mock('../voucher-pdf/voucher-pdf.service', () => ({
  VoucherPdfService: class {},
}));

import { VouchersService } from './vouchers.service';
import type { RegenerateVoucherDto } from './dto/regenerate-voucher.dto';

/**
 * TAFSD-550 (Rule B): Regenerate on the latest voucher reissues it through
 * create() with the /fee-challan settings, billing exactly what the voucher
 * bills. The supersession / PAY IMMEDIATELY / arrears behaviour itself is
 * create()'s and is covered by its own specs and by the DB suite
 * (test/db/voucher-regenerate.db-spec.ts); this pins the hand-off and the guards.
 */

const settings: RegenerateVoucherDto = {
  issue_date: '2026-11-21',
  due_date: '2026-12-01',
  validity_date: '2026-12-06',
  bank_account_id: 3,
  late_fee_charge: true,
  late_fee_amount: 1500,
  reprint_fee_charge: true,
  reprint_fee_amount: 200,
  waive_surcharge: true,
  waived_by: 'clerk',
  send_notification: false,
  requires_release: true,
  is_revised: true,
  pay_immediately_custom_dates: true,
};

const head = (id: number, over: any = {}) => ({
  student_fee_id: id,
  discount_label: null,
  student_fees: { status: 'ISSUED', is_discount: false },
  ...over,
});

const voucherRow = (over: any = {}) => ({
  id: 77,
  student_id: 500,
  campus_id: 1,
  class_id: 4,
  section_id: 2,
  bank_account_id: 1,
  status: 'OVERDUE',
  fee_date: new Date('2026-11-01T00:00:00Z'),
  issue_date: new Date('2026-11-01T00:00:00Z'),
  academic_year: '2026-2027',
  month: 11,
  voucher_heads: [head(11), head(12), head(13, { discount_label: 'Sibling', student_fees: { status: 'DISCOUNT', is_discount: true } })],
  ...over,
});

function build(voucher: any, latestId = voucher.id) {
  const prisma: any = {
    vouchers: {
      findUnique: jest.fn(async ({ select }: any) => (select?.voucher_heads ? voucher : { status: 'VOID' })),
      findFirst: jest.fn(async () => ({ id: latestId })),
    },
  };
  const auditLogs = { log: jest.fn() };
  const service = new VouchersService(prisma, {} as any, {} as any, {} as any, auditLogs as any, {} as any, {} as any);
  const create = jest.spyOn(service, 'create').mockResolvedValue({ id: 90 } as any);
  const generatePdf = jest.spyOn(service, 'generatePdf').mockResolvedValue({ pdf_url: 'u', filename: 'f' } as any);
  jest.spyOn(service, 'resolveGeneratedByName').mockResolvedValue('Clerk');
  return { service, prisma, auditLogs, create, generatePdf };
}

describe('regenerateVoucher', () => {
  it('reissues through create() with every setting and the voucher\'s own period and heads', async () => {
    const { service, create, generatePdf, auditLogs } = build(voucherRow());

    const res = await service.regenerateVoucher(77, settings, 'clerk');

    expect(create).toHaveBeenCalledTimes(1);
    const [dto, pdf, changedBy] = create.mock.calls[0];
    expect(pdf).toBeUndefined();
    expect(changedBy).toBe('clerk');
    expect(dto).toMatchObject({
      ...settings,
      student_id: 500,
      campus_id: 1,
      class_id: 4,
      section_id: 2,
      fee_date: '2026-11-01',
      academic_year: '2026-2027',
      month: 11,
      orderedFeeIds: [11, 12, 13],
      fee_lines: [{ student_fee_id: 13, discount_label: 'Sibling' }],
    });
    expect(generatePdf).toHaveBeenCalledWith(90, true, false, 'Clerk');
    expect(res).toMatchObject({ replaced_voucher_id: 77, pdf_url: 'u', voucher: { id: 90 } });
    expect(auditLogs.log).toHaveBeenCalledWith(expect.objectContaining({ entity_id: '90', old_value: '77' }));
  });

  it('keeps the voucher\'s bank when none is chosen', async () => {
    const { service, create } = build(voucherRow());
    await service.regenerateVoucher(77, { ...settings, bank_account_id: undefined }, 'clerk');
    expect(create.mock.calls[0][0].bank_account_id).toBe(1);
  });

  it.each(['UNPAID', 'OVERDUE', 'EXPIRED'])('reissues a %s voucher', async (status) => {
    const { service, create } = build(voucherRow({ status }));
    await service.regenerateVoucher(77, settings, 'clerk');
    expect(create).toHaveBeenCalled();
  });

  it('refuses a voucher that is not the student\'s latest', async () => {
    const { service, create } = build(voucherRow(), 99);
    await expect(service.regenerateVoucher(77, settings, 'clerk')).rejects.toThrow(/most recent/);
    expect(create).not.toHaveBeenCalled();
  });

  it('sends a partially paid voucher to Split', async () => {
    const { service, create } = build(voucherRow({ status: 'PARTIALLY_PAID' }));
    await expect(service.regenerateVoucher(77, settings, 'clerk')).rejects.toThrow(/Split/);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['PAID', 'WAIVED', 'VOID'])('refuses a %s voucher', async (status) => {
    const { service, create } = build(voucherRow({ status }));
    await expect(service.regenerateVoucher(77, settings, 'clerk')).rejects.toThrow(status);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a voucher with no fee date (supersession could not void it)', async () => {
    const { service, create } = build(voucherRow({ fee_date: null }));
    await expect(service.regenerateVoucher(77, settings, 'clerk')).rejects.toThrow(/no fee date/);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an issue date before the old voucher\'s, which would leave the old one "latest"', async () => {
    const { service, create } = build(voucherRow());
    await expect(
      service.regenerateVoucher(77, { ...settings, issue_date: '2026-10-31' }, 'clerk'),
    ).rejects.toThrow(/can't be earlier/);
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a voucher whose every charged head is waived (create() would skip supersession)', async () => {
    const waived = { student_fees: { status: 'WAIVED', is_discount: false } };
    const { service, create } = build(voucherRow({ voucher_heads: [head(11, waived), head(12, waived)] }));
    await expect(service.regenerateVoucher(77, settings, 'clerk')).rejects.toThrow(/waived/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('regenerateVoucher — PDF render', () => {
  it('still reports the reissue when the render fails', async () => {
    const { service, generatePdf } = build(voucherRow());
    generatePdf.mockRejectedValueOnce(new Error('storage down'));
    const res = await service.regenerateVoucher(77, settings, 'clerk');
    expect(res).toMatchObject({ voucher: { id: 90 }, replaced_voucher_id: 77, pdf_url: null });
  });
});
