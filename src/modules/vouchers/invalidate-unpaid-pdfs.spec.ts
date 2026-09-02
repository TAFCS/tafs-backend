import { UNPAID_PDF_INVALIDATION_WHERE, invalidateUnpaidVoucherPdfs, isFatherRelationship } from './invalidate-unpaid-pdfs';

describe('invalidateUnpaidVoucherPdfs', () => {
  it('updateMany where excludes PAID and VOID and only clears stored unpaid pdf_url', async () => {
    const prisma = {
      vouchers: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };

    await invalidateUnpaidVoucherPdfs(prisma, [1, 1, 2]);

    expect(prisma.vouchers.updateMany).toHaveBeenCalledWith({
      where: {
        student_id: { in: [1, 2] },
        status: { notIn: ['PAID', 'VOID'] },
        pdf_url: { not: null },
      },
      data: { pdf_url: null },
    });
    expect(UNPAID_PDF_INVALIDATION_WHERE.status).toEqual({ notIn: ['PAID', 'VOID'] });
  });

  it('no-ops on empty or invalid student ids', async () => {
    const prisma = {
      vouchers: { updateMany: jest.fn() },
    };

    await invalidateUnpaidVoucherPdfs(prisma, []);
    await invalidateUnpaidVoucherPdfs(prisma, [0, -1, NaN]);

    expect(prisma.vouchers.updateMany).not.toHaveBeenCalled();
  });
});

describe('isFatherRelationship', () => {
  it('matches father and not grandfather', () => {
    expect(isFatherRelationship('FATHER')).toBe(true);
    expect(isFatherRelationship('Step Father')).toBe(true);
    expect(isFatherRelationship('GRANDFATHER')).toBe(false);
    expect(isFatherRelationship('MOTHER')).toBe(false);
  });
});
