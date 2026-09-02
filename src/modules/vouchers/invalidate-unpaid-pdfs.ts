import { Prisma } from '@prisma/client';

/** Prisma client or a transaction - anything that can `vouchers.updateMany`. */
export type VoucherPdfPrisma = {
    vouchers: {
        updateMany: (
            args: Prisma.vouchersUpdateManyArgs,
        ) => Promise<Prisma.BatchPayload>;
    };
};

export const UNPAID_PDF_INVALIDATION_WHERE: Prisma.vouchersWhereInput = {
    status: { notIn: ['PAID', 'VOID'] },
    pdf_url: { not: null },
};

export function isFatherRelationship(rel: string | null | undefined): boolean {
    const r = (rel || '').trim().toUpperCase();
    return r === 'FATHER' || (r.includes('FATHER') && !r.includes('GRAND'));
}

/**
 * Clear stored unpaid renders so the next download re-renders with live
 * student/father identity. PAID receipts and VOID rows are left alone.
 */
export async function invalidateUnpaidVoucherPdfs(
    prisma: VoucherPdfPrisma,
    studentIds: number[],
): Promise<Prisma.BatchPayload> {
    const ids = [...new Set(studentIds.filter((id) => Number.isFinite(id) && id > 0))];
    if (ids.length === 0) {
        return { count: 0 };
    }
    return prisma.vouchers.updateMany({
        where: {
            student_id: { in: ids },
            ...UNPAID_PDF_INVALIDATION_WHERE,
        },
        data: { pdf_url: null },
    });
}
