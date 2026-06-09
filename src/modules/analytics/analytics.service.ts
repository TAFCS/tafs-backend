import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PostdatedChequesService } from '../postdated-cheques/postdated-cheques.service';

@Injectable()
export class AnalyticsService {
  constructor(
    private prisma: PrismaService,
    private postdatedChequesSvc: PostdatedChequesService,
  ) {}

  private getCurrentAcademicYear(): string {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); 
    const startYear = currentMonth >= 7 ? currentYear : currentYear - 1;
    return `${startYear}-${startYear + 1}`;
  }

  async getDashboardStats(campusId?: number, allowedClassIds: number[] = []) {
    const currentYear = this.getCurrentAcademicYear();
    const startYear = parseInt(currentYear.split('-')[0]);
    const today = new Date();

    const studentFilter: any = {
      status: 'ENROLLED',
      ...(campusId ? { campus_id: campusId } : {}),
      ...(allowedClassIds.length > 0
        ? { class_id: { in: allowedClassIds } }
        : {}),
      deleted_at: null,
    };

    const feeFilter: any = {
      students: studentFilter,
    };

    // ─────────────────────────────────────────────────────────────────────
    // Financials — kept strictly on two separate bases so the numbers never
    // get mixed:
    //   • ACCRUAL (what was billed / what remains unpaid against those bills):
    //     student_fees.amount + amount_paid, plus voucher_arrear_surcharges
    //     (the late-payment penalties — a real, predictable line item from
    //     the moment a voucher carrying an arrear is generated). Legacy
    //     is_arrear_surcharge rows and is_discount memo rows are excluded —
    //     surcharges now live in their own table, and a discount row's
    //     amount is already netted into the real fee head's `amount`, so
    //     counting both would double the bill.
    //   • CASH (what was actually banked): deposits.total_amount, keyed on
    //     deposit_date — the only timestamped ledger in the system. Reversed
    //     deposits are hard-deleted (see reverseDeposit/clearDeposit), so
    //     this is self-correcting with no extra status filter needed.
    // ─────────────────────────────────────────────────────────────────────
    const yearStart = new Date(startYear, 7, 1);
    const yearEnd = new Date(startYear + 1, 6, 31, 23, 59, 59, 999);

    const regularFeeWhere = {
      academic_year: currentYear,
      is_discount: false,
      is_arrear_surcharge: false,
      ...feeFilter,
    };

    const [feeAgg, surchargeAgg, cashAgg] = await Promise.all([
      this.prisma.student_fees.aggregate({
        where: regularFeeWhere,
        _sum: { amount: true, amount_paid: true },
      }),
      // Surcharges are attributed by the *carrying voucher's* billing period
      // (its fee_date), not the arrear month they penalize — the surcharge
      // doesn't exist as a charge until the arrear actually rolls over onto
      // a new voucher, so that's when it genuinely becomes "due".
      this.prisma.voucher_arrear_surcharges.aggregate({
        where: {
          waived: false,
          vouchers: { fee_date: { gte: yearStart, lte: yearEnd }, students: studentFilter },
        },
        _sum: { amount: true, amount_paid: true },
      }),
      this.prisma.deposits.aggregate({
        where: {
          deposit_date: { gte: yearStart, lte: yearEnd },
          students: studentFilter,
        },
        _sum: { total_amount: true },
      }),
    ]);

    const expected = Number(feeAgg._sum?.amount || 0) + Number(surchargeAgg._sum?.amount || 0);
    const collectedToDate = Number(feeAgg._sum?.amount_paid || 0) + Number(surchargeAgg._sum?.amount_paid || 0);
    const outstanding = expected - collectedToDate;
    const collected = Number(cashAgg._sum?.total_amount || 0);
    const collectionRate = expected > 0 ? (collected / expected) * 100 : 0;

    // 2. Arrears — amounts genuinely past their due date and still unpaid,
    // as of today. (NOT "a different academic_year string": arrears in this
    // system roll forward month-to-month *within* the same academic year, so
    // that filter was matching almost nothing real.) Late fees are excluded
    // here for the same reason they're excluded from "expected" below — see
    // note there.
    const [arrearsFeeAgg, arrearsSurchargeAgg] = await Promise.all([
      this.prisma.student_fees.aggregate({
        where: {
          status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
          due_date: { lt: today },
          is_discount: false,
          is_arrear_surcharge: false,
          ...feeFilter,
        },
        _sum: { amount: true, amount_paid: true },
      }),
      this.prisma.voucher_arrear_surcharges.aggregate({
        where: {
          waived: false,
          vouchers: { due_date: { lt: today }, students: studentFilter },
        },
        _sum: { amount: true, amount_paid: true },
      }),
    ]);

    const arrearsAmount =
      (Number(arrearsFeeAgg._sum?.amount || 0) - Number(arrearsFeeAgg._sum?.amount_paid || 0)) +
      (Number(arrearsSurchargeAgg._sum?.amount || 0) - Number(arrearsSurchargeAgg._sum?.amount_paid || 0));

    // Note on late fees (vouchers.late_fee_charge / late_fee_deposited):
    // unlike surcharges, a late fee is contingent — it only materializes if
    // a voucher is paid after its due date, so it can't be treated as a
    // stable "billed" amount without the figure retroactively shifting every
    // day. It's deliberately left out of expected/outstanding/arrears (which
    // describe predictable billing) but — being real money — it's still
    // fully captured in `collected` and in the monthly `received` figures
    // below, since both come straight from the deposits ledger.

    // 3. Student Strength
    const totalStudents = await this.prisma.students.count({
      where: studentFilter,
    });

    const branchCounts = await this.prisma.students.groupBy({
      by: ['campus_id'],
      where: studentFilter, 
      _count: {
        cc: true,
      },
    });

    // Resolve campus names and list
    const campusesList = await this.prisma.campuses.findMany({
        select: { id: true, campus_name: true },
        orderBy: { campus_name: 'asc' }
    });
    const campusMap = new Map(campusesList.map((c) => [c.id, c.campus_name]));

    const branchwiseStrength = branchCounts.map((b) => ({
      campus_id: b.campus_id,
      campus_name: campusMap.get(b.campus_id || 0) || 'Unknown',
      count: b._count.cc,
    }));

    // Monthly Trends — a TRAILING WINDOW of recent calendar months ending at
    // the current one (deliberately NOT the academic year). The institution
    // only went live on this system around June 2026, so an Aug-Jul "whole
    // year" view would be mostly empty months burying the few that actually
    // have data — not what an admin wants when checking "how are we doing
    // month to month". A trailing window is always centered on "now" and
    // fills in with real figures as time passes; it never ages out.
    //   • due      = regular fee heads BILLED FOR that calendar month
    //                (matched on target_month/academic_year — this is what
    //                keeps an arrear correctly attributed to the month it
    //                was originally for, e.g. September's unpaid tuition
    //                still counts as "due for September" even though it
    //                physically rides on October's voucher) plus arrear
    //                surcharges newly billed on vouchers issued for that
    //                period. A stable, accrual figure — once a period's
    //                billing closes, it doesn't move.
    //   • received = actual cash that arrived during that calendar month,
    //                straight from the deposits ledger (deposit_date). This
    //                is necessarily a blend of current dues + arrears +
    //                surcharges + late fees — exactly what really happened
    //                that month, with no attempt to attribute it back to
    //                whichever bill it settled.
    // These two are intentionally different lenses (billing vs. cash flow),
    // not the same measurement at two points in time — that conflation was
    // the original bug. Note: because this window can straddle an academic-
    // year boundary (e.g. a window spanning Jun-Nov would cross from
    // 2025-2026 into 2026-2027), each month resolves its OWN academic_year
    // string via academicYearFor() rather than assuming `currentYear` — so
    // "due" stays correct for that specific month no matter where the
    // window sits. (As a consequence, these monthly figures are no longer
    // guaranteed to sum to the yearly `expected`/`collected` headline
    // figures above — that's expected, not a bug, since the windows differ
    // on purpose.)
    const MONTHS_TO_SHOW = 6;
    const academicYearFor = (calYear: number, monthNum: number) => {
      const ayStartYear = monthNum >= 8 ? calYear : calYear - 1;
      return `${ayStartYear}-${ayStartYear + 1}`;
    };

    const trends: any[] = [];
    const feedate_trends: any[] = [];
    for (let offset = MONTHS_TO_SHOW - 1; offset >= 0; offset--) {
      const ref = new Date(today.getFullYear(), today.getMonth() - offset, 1);
      const calYear = ref.getFullYear();
      const jsMonth = ref.getMonth();
      const monthNum = jsMonth + 1;
      const label = ref.toLocaleString('en-US', { month: 'short', year: '2-digit' });
      const ay = academicYearFor(calYear, monthNum);

      const startDate = new Date(calYear, jsMonth, 1);
      const endDate = new Date(calYear, jsMonth + 1, 0, 23, 59, 59, 999);

      const [dueFeeAgg, dueSurchargeAgg, receivedAgg, feeDateAgg, overdueTargetAgg, overdueFeedateAgg] = await Promise.all([
        this.prisma.student_fees.aggregate({
          where: {
            target_month: monthNum,
            academic_year: ay,
            is_discount: false,
            is_arrear_surcharge: false,
            ...feeFilter,
          },
          _sum: { amount: true },
        }),
        // Surcharges on vouchers issued this calendar month — reused for both
        // trends.due and feedate_trends.due since both group by the voucher's fee_date.
        this.prisma.voucher_arrear_surcharges.aggregate({
          where: {
            waived: false,
            vouchers: { fee_date: { gte: startDate, lte: endDate }, students: studentFilter },
          },
          _sum: { amount: true, amount_paid: true },
        }),
        this.prisma.deposits.aggregate({
          where: {
            deposit_date: { gte: startDate, lte: endDate },
            students: studentFilter,
          },
          _sum: { total_amount: true },
        }),
        // fee_date-based view: all heads whose fee_date falls in this calendar
        // month, regardless of which target_month they were originally for.
        // amount_paid tracks how much of that voucher cycle has since been settled.
        this.prisma.student_fees.aggregate({
          where: {
            fee_date: { gte: startDate, lte: endDate },
            is_discount: false,
            is_arrear_surcharge: false,
            ...feeFilter,
          },
          _sum: { amount: true, amount_paid: true },
        }),
        // Overdue by target_month: heads originally for this month that are
        // still unpaid and past their due_date.
        this.prisma.student_fees.aggregate({
          where: {
            target_month: monthNum,
            academic_year: ay,
            status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
            due_date: { lt: today },
            is_discount: false,
            is_arrear_surcharge: false,
            ...feeFilter,
          },
          _sum: { amount: true, amount_paid: true },
        }),
        // Overdue by fee_date: heads from this billing cycle that are unpaid
        // and past their due_date.
        this.prisma.student_fees.aggregate({
          where: {
            fee_date: { gte: startDate, lte: endDate },
            status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
            due_date: { lt: today },
            is_discount: false,
            is_arrear_surcharge: false,
            ...feeFilter,
          },
          _sum: { amount: true, amount_paid: true },
        }),
      ]);

      const due = Number(dueFeeAgg._sum?.amount || 0) + Number(dueSurchargeAgg._sum?.amount || 0);
      const received = Number(receivedAgg._sum?.total_amount || 0);
      const overdue_target = Math.max(0,
        Number(overdueTargetAgg._sum?.amount || 0) - Number(overdueTargetAgg._sum?.amount_paid || 0),
      );

      trends.push({
        month: label,
        due,
        received,
        gap: due - received,
        overdue: overdue_target,
      });

      // feedate due includes surcharges on vouchers issued this month (same dueSurchargeAgg)
      const fd_due = Number(feeDateAgg._sum?.amount || 0) + Number(dueSurchargeAgg._sum?.amount || 0);
      const fd_collected = Number(feeDateAgg._sum?.amount_paid || 0) + Number(dueSurchargeAgg._sum?.amount_paid || 0);
      const fd_overdue = Math.max(0,
        Number(overdueFeedateAgg._sum?.amount || 0) - Number(overdueFeedateAgg._sum?.amount_paid || 0),
      );

      feedate_trends.push({
        month: label,
        due: fd_due,
        collected: fd_collected,
        gap: fd_due - fd_collected,
        overdue: fd_overdue,
      });
    }

    const postdatedCheques = await this.postdatedChequesSvc.getDashboardSummary();

    return {
      financials: {
        currentYear,
        expected,
        collected,
        outstanding,
        collectionRate,
        arrears: arrearsAmount,
      },
      students: {
        total: totalStudents,
        branchwise: branchwiseStrength,
      },
      campuses: campusesList,
      trends,
      feedate_trends,
      postdated_cheques: postdatedCheques,
    };
  }
}
