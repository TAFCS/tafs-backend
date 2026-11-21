/**
 * TAFSD-546. Read-only loader for the duplicate fee head audit. Every query
 * here is a SELECT; the whole load runs inside a READ ONLY transaction so a
 * mistake cannot write.
 */
import { PrismaClient } from '@prisma/client';
import {
  CopyAllocation,
  CopyVoucher,
  GroupResult,
  HeadCopy,
  buildGroups,
} from './classify';

export interface StudentInfo {
  cc: number;
  full_name: string;
  gr_number: string | null;
  campus: string;
  class_name: string;
  section: string;
  status: string;
}

export interface AuditData {
  groups: GroupResult[];
  students: Map<number, StudentInfo>;
  feeTypes: Map<number, string>;
}

const day = (d: Date | null | undefined) =>
  d ? new Date(d).toISOString().slice(0, 10) : null;
const num = (v: unknown) => (v == null ? 0 : Number(v));

/** student_fees.amount is the receivable; amount_before_discount is the documented fallback. */
export const receivable = (amount: unknown, before: unknown) =>
  num(amount ?? before ?? 0);

/**
 * Load candidate heads (non-discount, non-surcharge rows that share student,
 * fee type and academic year with another row on the same fee date or the same
 * target month), with their vouchers and deposit allocations, then classify.
 * Pass studentIds to restrict the load (tests, or re-checking a few students).
 */
export async function loadAudit(
  prisma: PrismaClient,
  opts: { studentIds?: number[] } = {},
): Promise<AuditData> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const only = opts.studentIds?.length ? opts.studentIds : null;
      const rows = await tx.$queryRawUnsafe<any[]>(
        `SELECT sf.id, sf.student_id, sf.fee_type_id, sf.fee_date, sf.academic_year, sf.target_month, sf.month,
                        sf.status::text AS status, sf.amount, sf.amount_before_discount, sf.amount_paid,
                        sf.description_prefix, sf.split_pair_id, sf.installment_id
                   FROM student_fees sf
                  WHERE sf.is_discount = false AND sf.is_arrear_surcharge = false
                    AND ($1::int[] IS NULL OR sf.student_id = ANY($1::int[]))
                    AND EXISTS (
                        SELECT 1 FROM student_fees o
                         WHERE o.id <> sf.id AND o.student_id = sf.student_id
                           AND o.is_discount = false AND o.is_arrear_surcharge = false
                           AND o.fee_type_id IS NOT DISTINCT FROM sf.fee_type_id
                           AND o.academic_year = sf.academic_year
                           AND (o.fee_date IS NOT DISTINCT FROM sf.fee_date OR o.target_month = sf.target_month))
                  ORDER BY sf.student_id, sf.id`,
        only,
      );
      const ids = rows.map((r) => r.id as number);
      const heads = ids.length
        ? await tx.voucher_heads.findMany({
            where: { student_fee_id: { in: ids } },
            select: {
              student_fee_id: true,
              vouchers: {
                select: {
                  id: true,
                  status: true,
                  voucher_number: true,
                  issue_date: true,
                },
              },
            },
          })
        : [];
      const allocs = ids.length
        ? await tx.deposit_allocations.findMany({
            where: { student_fee_id: { in: ids } },
            select: {
              id: true,
              student_fee_id: true,
              deposit_id: true,
              voucher_id: true,
              amount: true,
              type: true,
              deposits: { select: { deposit_date: true } },
            },
          })
        : [];
      const vByFee = new Map<number, CopyVoucher[]>();
      for (const h of heads) {
        const list = vByFee.get(h.student_fee_id) ?? [];
        list.push({
          id: h.vouchers.id,
          status: h.vouchers.status ?? 'UNPAID',
          voucher_number: h.vouchers.voucher_number,
          issue_date: day(h.vouchers.issue_date),
        });
        vByFee.set(h.student_fee_id, list);
      }
      const aByFee = new Map<number, CopyAllocation[]>();
      for (const a of allocs) {
        const list = aByFee.get(a.student_fee_id!) ?? [];
        list.push({
          id: a.id,
          deposit_id: a.deposit_id,
          voucher_id: a.voucher_id,
          amount: num(a.amount),
          type: a.type,
          deposit_date: a.deposits?.deposit_date
            ? new Date(a.deposits.deposit_date).toISOString()
            : null,
        });
        aByFee.set(a.student_fee_id!, list);
      }
      const copies: HeadCopy[] = rows.map((r) => ({
        id: r.id,
        student_id: r.student_id,
        fee_type_id: r.fee_type_id,
        fee_date: day(r.fee_date),
        academic_year: r.academic_year,
        target_month: r.target_month,
        month: r.month,
        status: r.status ?? 'NOT_ISSUED',
        amount: receivable(r.amount, r.amount_before_discount),
        amount_paid: num(r.amount_paid),
        description_prefix: r.description_prefix,
        split_pair_id: r.split_pair_id,
        installment_id: r.installment_id,
        vouchers: (vByFee.get(r.id) ?? []).sort((a, b) => a.id - b.id),
        allocations: (aByFee.get(r.id) ?? []).sort((a, b) => a.id - b.id),
      }));

      const groups = buildGroups(copies);
      const studentIds = [...new Set(groups.map((g) => g.student_id))];
      const students = new Map<number, StudentInfo>();
      if (studentIds.length) {
        const list = await tx.students.findMany({
          where: { cc: { in: studentIds } },
          select: {
            cc: true,
            full_name: true,
            gr_number: true,
            status: true,
            campuses: { select: { campus_name: true } },
            classes: { select: { description: true } },
            sections: { select: { description: true } },
          },
        });
        for (const s of list) {
          students.set(s.cc, {
            cc: s.cc,
            full_name: s.full_name,
            gr_number: s.gr_number,
            campus: s.campuses?.campus_name ?? '',
            class_name: s.classes?.description ?? '',
            section: s.sections?.description ?? '',
            status: String(s.status),
          });
        }
      }
      const feeTypes = new Map(
        (
          await tx.fee_types.findMany({
            select: { id: true, description: true },
          })
        ).map((f) => [f.id, f.description]),
      );
      return { groups, students, feeTypes };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}
