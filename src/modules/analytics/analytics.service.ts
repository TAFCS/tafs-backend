import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PostdatedChequesService } from '../postdated-cheques/postdated-cheques.service';
import { BackupsService } from '../backups/backups.service';

@Injectable()
export class AnalyticsService {
  constructor(
    private prisma: PrismaService,
    private postdatedChequesSvc: PostdatedChequesService,
    private backupsService: BackupsService,
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
          // A voucher that's been superseded/split keeps its old surcharge rows
          // (no cascade on a status change, only on an actual row delete), and
          // the replacement voucher gets its own fresh rows for the same arrear
          // — so a VOID carrier must be excluded here or the same surcharge is
          // counted twice. Mirrors the `hasValidVoucher` exclusion already
          // applied to fee heads elsewhere in this file.
          vouchers: { status: { not: 'VOID' }, fee_date: { gte: yearStart, lte: yearEnd }, students: studentFilter },
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
          vouchers: { status: { not: 'VOID' }, due_date: { lt: today }, students: studentFilter },
        },
        _sum: { amount: true, amount_paid: true },
      }),
    ]);

    const arrearsAmount =
      (Number(arrearsFeeAgg._sum?.amount || 0) - Number(arrearsFeeAgg._sum?.amount_paid || 0)) +
      (Number(arrearsSurchargeAgg._sum?.amount || 0) - Number(arrearsSurchargeAgg._sum?.amount_paid || 0));

    // 2b. Overdue vouchers — once a voucher passes its due_date unpaid, the
    // amount actually owed becomes total_payable_after_due (which bakes in
    // the Rs. 1,000 late fee, when late_fee_charge=true), not
    // total_payable_before_due. `arrearsAmount` above only covers the fee
    // heads / surcharges (the before_due portion); lateFeeOutstanding adds
    // the late-fee penalty that's now due on top of that.
    const overdueVoucherWhere = {
      status: { in: ['UNPAID', 'OVERDUE', 'PARTIALLY_PAID'] },
      due_date: { lt: today },
      students: studentFilter,
    };

    const [overdueVoucherCount, overdueLateFeeAgg, lateFeesCollectedAgg] = await Promise.all([
      this.prisma.vouchers.count({ where: overdueVoucherWhere }),
      this.prisma.vouchers.aggregate({
        where: { ...overdueVoucherWhere, late_fee_charge: true },
        _sum: { total_payable_after_due: true, total_payable_before_due: true, late_fee_deposited: true },
        _count: true,
      }),
      // Late fees actually banked this year, from vouchers that were paid
      // after their due_date. This cash is already inside `collected` /
      // `received` (it comes through the deposits ledger) — surfaced here
      // separately so it's clear those cash figures DO include late payers.
      this.prisma.vouchers.aggregate({
        where: {
          late_fee_deposited: { gt: 0 },
          fee_date: { gte: yearStart, lte: yearEnd },
          students: studentFilter,
        },
        _sum: { late_fee_deposited: true },
        _count: true,
      }),
    ]);

    const lateFeeOutstanding = Math.max(0,
      Number(overdueLateFeeAgg._sum?.total_payable_after_due || 0) -
      Number(overdueLateFeeAgg._sum?.total_payable_before_due || 0) -
      Number(overdueLateFeeAgg._sum?.late_fee_deposited || 0),
    );
    const overdueLateFeeVoucherCount = overdueLateFeeAgg._count || 0;
    const totalOwedNow = arrearsAmount + lateFeeOutstanding;
    const lateFeesCollected = Number(lateFeesCollectedAgg._sum?.late_fee_deposited || 0);
    const lateFeesCollectedCount = lateFeesCollectedAgg._count || 0;

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
    //
    // Two independent stats here, on two deliberately different bases:
    //
    // (1) trends — BILLED, grouped by the voucher's issue_date (the day the
    //     chit was actually generated/printed):
    //       due = SUM(vouchers.total_payable_before_due) for every voucher
    //             issued that calendar month, PLUS voucher_arrear_surcharges
    //             on those same vouchers.
    //     total_payable_before_due already sums every head on the voucher —
    //     current-period heads AND any prior-period arrears carried forward
    //     — so a month's "billed" figure automatically includes past arrears
    //     the moment they're re-issued, and the surcharge sum adds their
    //     late-payment penalty on top. VOID vouchers (superseded by
    //     splitPartiallyPaid) are excluded so a replacement voucher doesn't
    //     get double-counted alongside the one it replaced.
    //       received = SUM(student_fees.amount_paid) for every head riding on
    //                  those SAME vouchers (joined via voucher_heads — this
    //                  covers regular fees, bundle members, and installment
    //                  slices alike, since they're all just student_fees rows)
    //                  PLUS amount_paid on those vouchers' arrear surcharges.
    //     Deliberately NOT deposits.total_amount: a single deposit can pay
    //     off heads from several different vouchers/months at once, so
    //     keying off deposit_date mixes unrelated billing periods together.
    //     Summing amount_paid on the exact same heads/surcharges counted in
    //     `due` means received <= due by construction (a row's amount_paid
    //     can't exceed its amount) — a coherent numerator/denominator pair,
    //     not two independently-timed ledgers.
    //     KNOWN CAVEAT: vouchers are sometimes generated ahead of the period
    //     they're for (e.g. June 2026's vouchers might be issued in May
    //     2026). This stat counts strictly by issue_date, so that June
    //     voucher is "billed in May", full stop — regardless of which month
    //     it's actually for. This can shift amounts a month earlier than a
    //     reader might expect; that's a known, accepted simplification for
    //     now, not a bug.
    //     Separately, of the vouchers issued that month, however many have
    //     since flipped to status='OVERDUE' (unpaid, past due_date — see
    //     VouchersSchedulerService) now owe their late fee on top of the
    //     original bill. That Rs. amount and the exceeded/total voucher
    //     count are reported alongside due/received for that month.
    //
    // (2) feedate_trends — RECEIVABLE, grouped by student_fees.fee_date (the
    //     period a head is actually FOR — a row with fee_date=2026-06-01 is
    //     a June 2026 head, however many times it's been re-issued since):
    //       due       = SUM(amount)       for every head with that fee_date
    //       collected = SUM(amount_paid)  for the same heads
    //     This deliberately EXCLUDES voucher_arrear_surcharges and ignores
    //     due_date/overdue status entirely — it is a pure fee-ledger view
    //     (what's receivable, what's been received against it), not a
    //     billing-instrument view. Late fees and arrear surcharges never
    //     appear here; see stat (1) for those.
    const MONTHS_TO_SHOW = 6;

    const trends: any[] = [];
    const feedate_trends: any[] = [];
    for (let offset = MONTHS_TO_SHOW - 1; offset >= 0; offset--) {
      const ref = new Date(today.getFullYear(), today.getMonth() - offset, 1);
      const calYear = ref.getFullYear();
      const jsMonth = ref.getMonth();
      const label = ref.toLocaleString('en-US', { month: 'short', year: '2-digit' });

      const startDate = new Date(calYear, jsMonth, 1);
      const endDate = new Date(calYear, jsMonth + 1, 0, 23, 59, 59, 999);

      // Vouchers actually issued (printed) in this calendar month — this is
      // the billing-instrument lens, deliberately distinct from fee_date.
      const issuedVoucherWhere = {
        issue_date: { gte: startDate, lte: endDate },
        status: { not: 'VOID' },
        students: studentFilter,
      };

      const [voucherAgg, voucherSurchargeAgg, totalIssuedCount, overdueAgg, overdueCount, paidFeeAgg, feeDateAgg, feeDateIssuedAgg] = await Promise.all([
        this.prisma.vouchers.aggregate({
          where: issuedVoucherWhere,
          _sum: { total_payable_before_due: true },
        }),
        // amount = billed (surcharge side of `due`); amount_paid = collected
        // (surcharge side of `received`) — same surcharge rows, both sums.
        this.prisma.voucher_arrear_surcharges.aggregate({
          where: { waived: false, vouchers: issuedVoucherWhere },
          _sum: { amount: true, amount_paid: true },
        }),
        this.prisma.vouchers.count({ where: issuedVoucherWhere }),
        // Of THIS month's issued vouchers, the ones that have since gone
        // OVERDUE (unpaid, past due_date) now owe their late fee too.
        this.prisma.vouchers.aggregate({
          where: { ...issuedVoucherWhere, status: 'OVERDUE', late_fee_charge: true },
          _sum: { total_payable_after_due: true, total_payable_before_due: true, late_fee_deposited: true },
        }),
        this.prisma.vouchers.count({ where: { ...issuedVoucherWhere, status: 'OVERDUE' } }),
        // Collected = amount_paid on every student_fees head riding on THESE
        // SAME vouchers (joined via voucher_heads) — regular fees, bundle
        // members, and installment slices are all just student_fees rows, so
        // this one aggregate naturally covers all of them. Deliberately NOT
        // deposits.total_amount: a deposit can pay off heads from several
        // different vouchers/months in one transaction, so keying off
        // deposit_date mixes unrelated billing periods together and can make
        // "received" exceed "billed" for reasons that have nothing to do
        // with this month's vouchers. Summing amount_paid on the exact heads
        // counted in `due` guarantees received <= due by construction
        // (amount_paid can't exceed amount on a row), so this is the
        // accurate "how much of what we billed this month has come in" figure.
        this.prisma.student_fees.aggregate({
          where: {
            is_discount: false,
            is_arrear_surcharge: false,
            voucher_heads: { some: { vouchers: issuedVoucherWhere } },
            ...feeFilter,
          },
          _sum: { amount_paid: true },
        }),
        // fee_date-based view: every head whose fee_date falls in this
        // calendar month, regardless of which voucher it currently rides on.
        // No surcharges, no due_date — see comment block above. Includes
        // NOT_ISSUED rows — template heads that exist in the ledger but were
        // never actually put on a voucher.
        this.prisma.student_fees.aggregate({
          where: {
            fee_date: { gte: startDate, lte: endDate },
            is_discount: false,
            is_arrear_surcharge: false,
            ...feeFilter,
          },
          _sum: { amount: true, amount_paid: true },
        }),
        // Same, but excluding NOT_ISSUED rows — only heads that were actually
        // billed to the student at some point (ISSUED/PARTIALLY_PAID/PAID).
        this.prisma.student_fees.aggregate({
          where: {
            fee_date: { gte: startDate, lte: endDate },
            is_discount: false,
            is_arrear_surcharge: false,
            status: { not: 'NOT_ISSUED' },
            ...feeFilter,
          },
          _sum: { amount: true, amount_paid: true },
        }),
      ]);

      const due = Number(voucherAgg._sum?.total_payable_before_due || 0) + Number(voucherSurchargeAgg._sum?.amount || 0);
      const received = Number(paidFeeAgg._sum?.amount_paid || 0) + Number(voucherSurchargeAgg._sum?.amount_paid || 0);
      const lateFeeAdded = Math.max(0,
        Number(overdueAgg._sum?.total_payable_after_due || 0) -
        Number(overdueAgg._sum?.total_payable_before_due || 0) -
        Number(overdueAgg._sum?.late_fee_deposited || 0),
      );

      trends.push({
        month: label,
        due,
        received,
        gap: due - received,
        totalIssuedCount,
        overdueCount,
        lateFeeAdded,
      });

      const fdDue = Number(feeDateAgg._sum?.amount || 0);
      const fdCollected = Number(feeDateAgg._sum?.amount_paid || 0);
      const fdDueIssued = Number(feeDateIssuedAgg._sum?.amount || 0);
      const fdCollectedIssued = Number(feeDateIssuedAgg._sum?.amount_paid || 0);

      feedate_trends.push({
        month: label,
        due: fdDue,
        collected: fdCollected,
        gap: fdDue - fdCollected,
        // Same fee_date grouping, excluding NOT_ISSUED template rows.
        dueIssuedOnly: fdDueIssued,
        collectedIssuedOnly: fdCollectedIssued,
        gapIssuedOnly: fdDueIssued - fdCollectedIssued,
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
        overdueVoucherCount,
        lateFeeOutstanding,
        overdueLateFeeVoucherCount,
        totalOwedNow,
        lateFeesCollected,
        lateFeesCollectedCount,
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

  async getModuleStats(campusId?: number, allowedClassIds: number[] = []) {
    const currentYear = this.getCurrentAcademicYear();
    const startYear = parseInt(currentYear.split('-')[0]);
    const yearStart = new Date(startYear, 7, 1);
    const yearEnd = new Date(startYear + 1, 6, 31, 23, 59, 59, 999);
    const today = new Date();
    const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    const studentFilter: any = {
      status: 'ENROLLED',
      ...(campusId ? { campus_id: campusId } : {}),
      ...(allowedClassIds.length > 0 ? { class_id: { in: allowedClassIds } } : {}),
      deleted_at: null,
    };

    const feeFilter: any = {
      students: studentFilter,
    };

    const regularFeeWhere = {
      academic_year: currentYear,
      is_discount: false,
      is_arrear_surcharge: false,
      ...feeFilter,
    };

    // 1. Student stats
    const [totalEnrolled, newRegistrations, activeFamilies, openTransfers] = await Promise.all([
      this.prisma.students.count({
        where: {
          status: 'ENROLLED',
          ...(campusId ? { campus_id: campusId } : {}),
          ...(allowedClassIds.length > 0 ? { class_id: { in: allowedClassIds } } : {}),
          deleted_at: null,
        },
      }),
      this.prisma.students.count({
        where: {
          status: 'SOFT_ADMISSION',
          ...(campusId ? { campus_id: campusId } : {}),
          ...(allowedClassIds.length > 0 ? { class_id: { in: allowedClassIds } } : {}),
          deleted_at: null,
        },
      }),
      this.prisma.families.count({
        where: {
          deleted_at: null,
          ...(campusId || allowedClassIds.length > 0
            ? {
                students: {
                  some: {
                    deleted_at: null,
                    ...(campusId ? { campus_id: campusId } : {}),
                    ...(allowedClassIds.length > 0 ? { class_id: { in: allowedClassIds } } : {}),
                  },
                },
              }
            : {}),
        },
      }),
      this.prisma.audit_logs.count({
        where: {
          entity_type: 'TRANSFER',
          ...(campusId || allowedClassIds.length > 0
            ? {
                students: {
                  deleted_at: null,
                  ...(campusId ? { campus_id: campusId } : {}),
                  ...(allowedClassIds.length > 0 ? { class_id: { in: allowedClassIds } } : {}),
                },
              }
            : {}),
        },
      }),
    ]);

    // 2. Finance stats
    const [feeAgg, surchargeAgg, cashAgg, vouchersIssued] = await Promise.all([
      this.prisma.student_fees.aggregate({
        where: regularFeeWhere,
        _sum: { amount: true, amount_paid: true },
      }),
      this.prisma.voucher_arrear_surcharges.aggregate({
        where: {
          waived: false,
          vouchers: {
            status: { not: 'VOID' },
            fee_date: { gte: yearStart, lte: yearEnd },
            students: studentFilter,
          },
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
      this.prisma.vouchers.count({
        where: {
          status: { not: 'VOID' },
          academic_year: currentYear,
          students: studentFilter,
        },
      }),
    ]);

    const expected = Number(feeAgg._sum?.amount || 0) + Number(surchargeAgg._sum?.amount || 0);
    const collectedToDate = Number(feeAgg._sum?.amount_paid || 0) + Number(surchargeAgg._sum?.amount_paid || 0);
    const outstanding = expected - collectedToDate;
    const collected = Number(cashAgg._sum?.total_amount || 0);
    const collectionRate = expected > 0 ? (collected / expected) * 100 : 0;

    // 3. Communication stats
    const ticketCampusFilter = campusId || allowedClassIds.length > 0
      ? {
          OR: [
            { students: { deleted_at: null, ...(campusId ? { campus_id: campusId } : {}), ...(allowedClassIds.length > 0 ? { class_id: { in: allowedClassIds } } : {}) } },
            { families: { students: { some: { deleted_at: null, ...(campusId ? { campus_id: campusId } : {}), ...(allowedClassIds.length > 0 ? { class_id: { in: allowedClassIds } } : {}) } } } }
          ]
        }
      : {};

    const [openTickets, announcements, unreadTicketsAgg, resolvedToday] = await Promise.all([
      this.prisma.support_tickets.count({
        where: {
          status: { in: ['OPEN', 'ASSIGNED'] },
          ...ticketCampusFilter,
        },
      }),
      this.prisma.notice_board_posts.count({
        where: {
          deleted_at: null,
          ...(campusId ? { OR: [{ campus_ids: { has: campusId } }, { campus_ids: { equals: [] } }] } : {}),
        },
      }),
      this.prisma.support_tickets.aggregate({
        where: {
          status: { in: ['OPEN', 'ASSIGNED'] },
          ...ticketCampusFilter,
        },
        _sum: { unread_by_staff: true },
      }),
      this.prisma.support_tickets.count({
        where: {
          status: 'CLOSED',
          closed_at: { gte: todayDate },
          ...ticketCampusFilter,
        },
      }),
    ]);

    const unread = unreadTicketsAgg._sum?.unread_by_staff || 0;

    // 4. HR stats
    const hrCampusFilter = campusId ? { campus_id: campusId } : {};

    const [totalStaff, onLeave, departments, payrollRuns] = await Promise.all([
      this.prisma.employee_profiles.count({
        where: {
          ...hrCampusFilter,
          users: { is_active: true, deleted_at: null },
        },
      }),
      this.prisma.leave_requests.count({
        where: {
          status: 'APPROVED',
          start_date: { lte: todayDate },
          end_date: { gte: todayDate },
          employee_profiles: {
            ...hrCampusFilter,
            users: { is_active: true, deleted_at: null },
          },
        },
      }),
      this.prisma.departments.count(),
      this.prisma.payroll_runs.count({
        where: {
          ...(campusId ? { campus_id: campusId } : {}),
        },
      }),
    ]);

    // 5. Attendance stats
    const [presentStaff, presentStudents, absentStudents, lateStudents] = await Promise.all([
      this.prisma.attendance_staff_daily.count({
        where: {
          date: todayDate,
          status: { in: ['PRESENT', 'LATE', 'HALF_DAY'] },
          ...(campusId ? { campus_id: campusId } : {}),
        },
      }),
      this.prisma.attendance_student_daily.count({
        where: {
          date: todayDate,
          status: { in: ['PRESENT', 'LATE'] },
          ...(campusId ? { campus_id: campusId } : {}),
          students: {
            ...(allowedClassIds.length > 0 ? { class_id: { in: allowedClassIds } } : {}),
            deleted_at: null,
          },
        },
      }),
      this.prisma.attendance_student_daily.count({
        where: {
          date: todayDate,
          status: 'ABSENT',
          ...(campusId ? { campus_id: campusId } : {}),
          students: {
            ...(allowedClassIds.length > 0 ? { class_id: { in: allowedClassIds } } : {}),
            deleted_at: null,
          },
        },
      }),
      this.prisma.attendance_student_daily.count({
        where: {
          date: todayDate,
          status: 'LATE',
          ...(campusId ? { campus_id: campusId } : {}),
          students: {
            ...(allowedClassIds.length > 0 ? { class_id: { in: allowedClassIds } } : {}),
            deleted_at: null,
          },
        },
      }),
    ]);

    // 6. School Setup stats
    const [campusesCount, classesCount, sectionsCount, feeTypesCount] = await Promise.all([
      this.prisma.campuses.count({ where: { is_active: true } }),
      this.prisma.classes.count(),
      this.prisma.sections.count(),
      this.prisma.fee_types.count(),
    ]);

    // 7. System stats
    let lastBackupStr = 'Never';
    try {
      const backups = await this.backupsService.listBackups();
      if (backups && backups.length > 0) {
        const lastBackup = backups[0];
        if (lastBackup && lastBackup.lastModified) {
          lastBackupStr = new Date(lastBackup.lastModified).toLocaleString('en-US', {
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          });
        }
      }
    } catch (err) {
      // Don't crash if backups fail to list
    }

    const [totalUsers, distinctRoles, activeSessions] = await Promise.all([
      this.prisma.users.count({
        where: {
          deleted_at: null,
          ...(campusId ? { campus_id: campusId } : {}),
        },
      }),
      this.prisma.role_permissions.groupBy({
        by: ['role'],
      }),
      this.prisma.user_refresh_tokens.count({
        where: {
          revoked_at: null,
          expires_at: { gt: new Date() },
          ...(campusId ? { users: { campus_id: campusId } } : {}),
        },
      }),
    ]);

    return {
      student: {
        'Total Enrolled': totalEnrolled,
        'New Registrations': newRegistrations,
        'Active Families': activeFamilies,
        'Open Transfers': openTransfers,
      },
      finance: {
        'Fees Collected': collected,
        'Outstanding': outstanding,
        'Vouchers Issued': vouchersIssued,
        'Collection Rate': collectionRate,
      },
      communication: {
        'Open Tickets': openTickets,
        'Announcements': announcements,
        'Unread': unread,
        'Resolved Today': resolvedToday,
      },
      hr: {
        'Total Staff': totalStaff,
        'On Leave': onLeave,
        'Departments': departments,
        'Payroll Runs': payrollRuns,
      },
      attendance: {
        'Present (Staff)': presentStaff,
        'Present (Students)': presentStudents,
        'Absent': absentStudents,
        'Late Arrivals': lateStudents,
      },
      'school-setup': {
        'Campuses': campusesCount,
        'Classes': classesCount,
        'Sections': sectionsCount,
        'Fee Types': feeTypesCount,
      },
      system: {
        'Total Users': totalUsers,
        'Roles Defined': distinctRoles.length,
        'Last Backup': lastBackupStr,
        'Active Sessions': activeSessions,
      },
    };
  }
}

