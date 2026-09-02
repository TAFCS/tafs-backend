import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import ExcelJS from 'exceljs';
import {
  FinancialReportSnapshotStatus,
  FinancialReportType,
  Prisma,
  fee_status_enum,
  student_status,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { applyStudentScope } from '../../common/staff-scope';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import { buildGraduationFilterWhere } from '../../common/utils/graduation-filter.util';
import {
  calendarYearOf,
  getMonthYearLabel,
  monthAbsoluteIndex,
  termOfHead,
} from '../../common/utils/academic-labels';
import { createPaginationMeta } from '../../utils/serializer.util';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import {
  bandForMonthsBehind,
  LPS_PER_ARREAR_MONTH,
  SEVERITY_BANDS,
  SEVERITY_BAND_LABELS,
  type SeverityBand,
} from './defaulter-severity';
import type {
  DefaulterSortField,
  DefaulterView,
  ExportDefaultersQueryDto,
  ExportDepositsQueryDto,
  ExportFeeHeadsQueryDto,
  ExportFeeMatrixQueryDto,
  FinancialReportQueryDto,
  ListDefaultersQueryDto,
  ListDepositsQueryDto,
  ListFeeHeadsQueryDto,
  ListFeeMatrixQueryDto,
  StudentScopeFilterQueryDto,
} from './dto/financial-report-query.dto';
import type {
  CreateFeeHeadsSnapshotDto,
  ListFeeHeadsSnapshotsQueryDto,
} from './dto/financial-report-snapshot.dto';

const EXPORT_ROW_CAP = 25_000;
/** Safety valve on the matrix's statistics fetch — a filtered set larger than this is truncated, not failed. */
const STATS_ROW_CAP = 50_000;
/** Safety valve on the matrix's month-range width (3 years) — an absurdly wide range is capped, not failed. */
const MATRIX_MAX_MONTHS = 36;
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1E3A8A' },
};

const ALLOCATION_TYPES = ['FEE_HEAD', 'LATE_FEE', 'SURCHARGE'] as const;
type AllocationType = (typeof ALLOCATION_TYPES)[number];

const FEE_HEAD_SELECT = {
  id: true,
  fee_date: true,
  status: true,
  amount: true,
  amount_paid: true,
  target_month: true,
  academic_year: true,
  term_start_month: true,
  description_prefix: true,
  is_discount: true,
  discount_presets: { select: { title: true } },
  students: {
    select: {
      cc: true,
      gr_number: true,
      full_name: true,
      status: true,
      class_id: true,
      graduated_from_class_id: true,
      campuses: { select: { campus_name: true } },
      classes: {
        select: { id: true, description: true, term_start_month: true },
      },
      graduated_from_class: {
        select: { id: true, description: true, term_start_month: true },
      },
      sections: { select: { description: true } },
    },
  },
    fee_types: { select: { description: true } },
} satisfies Prisma.student_feesSelect;

const DEPOSIT_SELECT = {
  id: true,
  deposit_date: true,
  payment_method: true,
  bank_name: true,
  reference_number: true,
  total_amount: true,
  deposit_allocations: {
    select: { type: true, amount: true },
  },
  students: {
    select: {
      cc: true,
      gr_number: true,
      full_name: true,
      campuses: { select: { campus_name: true } },
      classes: { select: { description: true } },
      sections: { select: { description: true } },
    },
  },
} satisfies Prisma.depositsSelect;

const MATRIX_STUDENT_SELECT = {
  cc: true,
  gr_number: true,
  full_name: true,
  status: true,
  class_id: true,
  graduated_from_class_id: true,
  campuses: { select: { campus_name: true } },
  classes: { select: { description: true } },
  graduated_from_class: { select: { description: true } },
  sections: { select: { description: true } },
} satisfies Prisma.studentsSelect;

const MATRIX_HEAD_SELECT = {
  id: true,
  student_id: true,
  target_month: true,
  academic_year: true,
  term_start_month: true,
  amount: true,
  status: true,
  description_prefix: true,
  fee_type_id: true,
  is_discount: true,
  discount_presets: { select: { title: true } },
  fee_types: { select: { description: true } },
  students: {
    select: {
      status: true,
      class_id: true,
      graduated_from_class_id: true,
    },
  },
} satisfies Prisma.student_feesSelect;

type MatrixCell = {
  id: number;
  fee_type: string;
  amount: number;
  status: fee_status_enum;
};

type DistributionStats = {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  /** Values tied for most frequent; empty when nothing repeats (no mode). */
  mode: number[];
  variance_population: number;
  variance_sample: number;
  stddev_population: number;
  stddev_sample: number;
};

type FeeTypeStatistics = DistributionStats & {
  fee_type_id: number;
  fee_type: string;
};

export type ExportFile = {
  buffer: Buffer;
  filename: string;
  contentType: string;
};

/**
 * Hard ceiling on the Defaulters report's scoped student fetch. Unlike
 * STATS_ROW_CAP this THROWS rather than truncating — see listDefaulters.
 */
const SCOPE_ROW_CAP = 25_000;

const DEFAULTER_STUDENT_SELECT = {
  cc: true,
  gr_number: true,
  full_name: true,
  status: true,
  campus_id: true,
  class_id: true,
  graduated_from_class_id: true,
  is_fee_endowment: true,
  is_complementary: true,
  campuses: { select: { campus_name: true } },
  classes: { select: { description: true } },
  graduated_from_class: { select: { description: true } },
  sections: { select: { description: true } },
} satisfies Prisma.studentsSelect;

/** MATRIX_HEAD_SELECT plus the columns the strip's cell state needs. */
const DEFAULTER_HEAD_SELECT = {
  ...MATRIX_HEAD_SELECT,
  fee_date: true,
  amount_paid: true,
  amount_before_discount: true,
} satisfies Prisma.student_feesSelect;

type DefaulterStudent = Prisma.studentsGetPayload<{
  select: typeof DEFAULTER_STUDENT_SELECT;
}>;
type DefaulterHead = Prisma.student_feesGetPayload<{
  select: typeof DEFAULTER_HEAD_SELECT;
}>;

type DefaulterCategory = 'ARREARS' | 'EXPIRING';

/**
 * Per-student result of loadDefaulterEligibility — whether they belong on the
 * report at all, and if so why. See defaulter-severity.ts for the two
 * qualifying situations.
 */
type DefaulterEligibility = {
  student_id: number;
  category: DefaulterCategory;
  /** COUNT(DISTINCT arrear_year, arrear_month) across active vouchers' surcharge rows. 0 for EXPIRING. */
  months_behind: number;
  /** "<arrear_year>_<arrear_month>" keys, for the strip's red-cell cross-reference and the oldest-arrear label. */
  arrear_group_keys: string[];
  lps_charged: number;
  lps_paid: number;
  lps_outstanding: number;
  lps_waived: number;
  unreleased_voucher_count: number;
};

/** Raw shape off the money-only $queryRaw, before ::int/::float8 values are normalised. */
type DefaulterMoneyRaw = {
  student_id: number;
  arrears_outstanding: number | null;
  arrear_head_count: number;
  oldest_arrear_fee_date: Date | null;
  newest_arrear_fee_date: Date | null;
};

type DefaulterMoney = {
  arrears_outstanding: number;
  arrear_head_count: number;
  oldest_arrear_fee_date: Date | null;
  newest_arrear_fee_date: Date | null;
};

const EMPTY_MONEY: DefaulterMoney = {
  arrears_outstanding: 0,
  arrear_head_count: 0,
  oldest_arrear_fee_date: null,
  newest_arrear_fee_date: null,
};

type DefaulterRow = DefaulterEligibility &
  DefaulterMoney & {
    severity: SeverityBand;
    student: DefaulterStudent;
  };

type StripCellState = 'not_billed' | 'unpaid' | 'partial' | 'paid';

type StripCell = {
  year: number;
  month: number;
  state: StripCellState;
  /** In the student's ledger arrear_group_keys — this, not `state`, is what gets tinted red. */
  is_arrear: boolean;
  amount: number;
  outstanding: number;
  head_count: number;
  /** (academic_year, target_month) keys resolving into this cell; >1 when a term change straddles it. */
  group_keys: string[];
};

type PaymentBehaviour = {
  last_payment_date: Date | null;
  payments_last_6m: number;
  paid_last_6m: number;
  payments_last_12m: number;
  paid_last_12m: number;
};

const EMPTY_PAYMENTS: PaymentBehaviour = {
  last_payment_date: null,
  payments_last_6m: 0,
  paid_last_6m: 0,
  payments_last_12m: 0,
  paid_last_12m: 0,
};

@Injectable()
export class FinancialReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async listFeeHeads(query: ListFeeHeadsQueryDto, user: IJwtStaffPayload) {
    this.assertDateRange(query);
    const view = query.view ?? 'heads';
    if (view === 'student') {
      return this.listFeeHeadsByStudent(query, user);
    }
    if (view === 'fee_type') {
      return this.listFeeHeadsByFeeType(query, user);
    }
    if (view === 'period') {
      return this.listFeeHeadsByPeriod(query, user);
    }
    if (view === 'class') {
      return this.listFeeHeadsByClass(query, user);
    }

    const leaf = this.feeHeadsLeafWhere(query);
    const studentWhere = this.buildStudentWhere(query, user);
    const where = { ...leaf, students: studentWhere };
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 200);

    const [rows, totals, classTerms, studentCount] = await Promise.all([
      this.prisma.student_fees.findMany({
        where,
        select: FEE_HEAD_SELECT,
        orderBy: [{ fee_date: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.feeHeadMoneyTotals(where),
      this.loadClassTerms(),
      this.prisma.students.count({
        where: { ...studentWhere, student_fees: { some: leaf } },
      }),
    ]);

    return {
      view: 'heads' as const,
      items: rows.map((row) => this.mapFeeHead(row, classTerms)),
      pagination: createPaginationMeta(page, limit, totals.count),
      totals: {
        ...totals,
        student_count: studentCount,
        ...this.buildTotalsCheck(totals),
      },
    };
  }

  private async listFeeHeadsByStudent(
    query: ListFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ) {
    const leaf = this.feeHeadsLeafWhere(query);
    const studentWhere = this.buildStudentWhere(query, user);
    const where: Prisma.student_feesWhereInput = {
      ...leaf,
      students: studentWhere,
    };
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 200);

    const nonDiscountWhere: Prisma.student_feesWhereInput = { ...where, is_discount: false };
    const [groups, totals, studentCount] = await Promise.all([
      this.prisma.student_fees.groupBy({
        by: ['student_id'],
        where: nonDiscountWhere,
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
        orderBy: { student_id: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.feeHeadMoneyTotals(where),
      this.prisma.students.count({
        where: { ...studentWhere, student_fees: { some: leaf } },
      }),
    ]);

    const studentIds = groups.map((g) => g.student_id);
    const [students, discGroups] = studentIds.length
      ? await Promise.all([
          this.prisma.students.findMany({
            where: { cc: { in: studentIds } },
            select: {
              cc: true,
              gr_number: true,
              full_name: true,
              status: true,
              class_id: true,
              graduated_from_class_id: true,
              campuses: { select: { campus_name: true } },
              classes: { select: { description: true } },
              graduated_from_class: { select: { description: true } },
              sections: { select: { description: true } },
            },
          }),
          // Discount amounts for exactly this page's students — merged in below,
          // sign-flipped, so "amount" nets to what's actually owed. See
          // financial-reports.service.ts's discount-handling notes above feeHeadMoneyTotals.
          this.prisma.student_fees.groupBy({
            by: ['student_id'],
            where: { ...where, is_discount: true, student_id: { in: studentIds } },
            _sum: { amount: true },
            _count: { _all: true },
          }),
        ])
      : [[], []];
    const studentMap = new Map(students.map((s) => [s.cc, s]));
    const discountByStudent = new Map(
      discGroups.map((d) => [d.student_id, { amount: this.toMoney(d._sum.amount), count: d._count._all }]),
    );

    return {
      view: 'student' as const,
      items: groups.map((group) => {
        const student = studentMap.get(group.student_id);
        const discount = discountByStudent.get(group.student_id);
        const billed = this.roundMoney(this.toMoney(group._sum.amount) - (discount?.amount ?? 0));
        const paid = this.toMoney(group._sum.amount_paid);
        return {
          cc: group.student_id,
          gr_number: student?.gr_number ?? null,
          student_name: student?.full_name ?? '',
          campus: student?.campuses?.campus_name ?? '',
          class_name: this.resolveStudentClassName(student),
          section: student?.sections?.description ?? '',
          head_count: group._count._all + (discount?.count ?? 0),
          amount: billed,
          amount_paid: paid,
          outstanding: this.roundMoney(billed - paid),
        };
      }),
      pagination: createPaginationMeta(page, limit, studentCount),
      totals: {
        ...totals,
        student_count: studentCount,
        ...this.buildTotalsCheck(totals),
      },
    };
  }

  private async listFeeHeadsByFeeType(
    query: ListFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ) {
    const leaf = this.feeHeadsLeafWhere(query);
    const studentWhere = this.buildStudentWhere(query, user);
    const where: Prisma.student_feesWhereInput = {
      ...leaf,
      students: studentWhere,
    };
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 200);

    // Discount rows have fee_type_id: null and no description_prefix, so they all fold
    // into one generic bucket here rather than being broken out per discount preset —
    // that finer detail is only available in the flat "heads" view and the Fee Matrix,
    // where each row/cell is labeled individually from discount_presets.title.
    const [groups, discGroups, totals, studentCount, feeTypes] = await Promise.all([
      this.prisma.student_fees.groupBy({
        by: ['fee_type_id', 'description_prefix'],
        where: { ...where, is_discount: false },
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
        orderBy: [{ fee_type_id: 'asc' }, { description_prefix: 'asc' }],
      }),
      this.prisma.student_fees.groupBy({
        by: ['fee_type_id', 'description_prefix'],
        where: { ...where, is_discount: true },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.feeHeadMoneyTotals(where),
      this.prisma.students.count({
        where: { ...studentWhere, student_fees: { some: leaf } },
      }),
      this.prisma.fee_types.findMany({
        select: { id: true, description: true },
      }),
    ]);

    const feeTypeMap = new Map(feeTypes.map((ft) => [ft.id, ft.description ?? '']));
    const groupKey = (g: { fee_type_id: number | null; description_prefix: string | null }) =>
      `${g.fee_type_id ?? ''}|${g.description_prefix ?? ''}`;
    const discountByKey = new Map(
      discGroups.map((d) => [groupKey(d), { amount: this.toMoney(d._sum.amount), count: d._count._all }]),
    );
    const seenKeys = new Set(groups.map(groupKey));
    const items = groups.map((group) => {
      const discount = discountByKey.get(groupKey(group));
      const amount = this.roundMoney(this.toMoney(group._sum.amount) - (discount?.amount ?? 0));
      const amountPaid = this.toMoney(group._sum.amount_paid);
      const feeName = group.fee_type_id != null ? feeTypeMap.get(group.fee_type_id) ?? '' : '';
      const feeType = [group.description_prefix, feeName].filter(Boolean).join(' ');
      return {
        fee_type_id: group.fee_type_id,
        fee_type: feeType || (group.fee_type_id == null ? 'Discount' : '—'),
        head_count: group._count._all + (discount?.count ?? 0),
        amount,
        amount_paid: amountPaid,
        outstanding: this.roundMoney(amount - amountPaid),
      };
    });
    // A discount bucket with no matching non-discount row (e.g. every fee head it
    // offsets fell outside this filter) still needs its own row so its amount isn't
    // silently dropped from the view.
    for (const disc of discGroups) {
      const key = groupKey(disc);
      if (seenKeys.has(key)) continue;
      items.push({
        fee_type_id: disc.fee_type_id,
        fee_type: 'Discount',
        head_count: disc._count._all,
        amount: -this.toMoney(disc._sum.amount),
        amount_paid: 0,
        outstanding: -this.toMoney(disc._sum.amount),
      });
    }
    const start = (page - 1) * limit;

    return {
      view: 'fee_type' as const,
      items: items.slice(start, start + limit),
      pagination: createPaginationMeta(page, limit, items.length),
      totals: {
        ...totals,
        student_count: studentCount,
        ...this.buildTotalsCheck(totals),
      },
    };
  }

  private async listFeeHeadsByPeriod(
    query: ListFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ) {
    const leaf = this.feeHeadsLeafWhere(query);
    const studentWhere = this.buildStudentWhere(query, user);
    const where: Prisma.student_feesWhereInput = {
      ...leaf,
      students: studentWhere,
    };
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 200);

    const [groups, discGroups, totals, studentCount, classTerms] = await Promise.all([
      this.prisma.student_fees.groupBy({
        by: ['target_month', 'academic_year', 'term_start_month'],
        where: { ...where, is_discount: false },
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
        orderBy: [{ academic_year: 'asc' }, { target_month: 'asc' }],
      }),
      this.prisma.student_fees.groupBy({
        by: ['target_month', 'academic_year', 'term_start_month'],
        where: { ...where, is_discount: true },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.feeHeadMoneyTotals(where),
      this.prisma.students.count({
        where: { ...studentWhere, student_fees: { some: leaf } },
      }),
      this.loadClassTerms(),
    ]);

    const periodKey = (g: { target_month: number; academic_year: string; term_start_month: number | null }) =>
      `${g.target_month}|${g.academic_year}|${g.term_start_month ?? ''}`;
    const discountByPeriod = new Map(
      discGroups.map((d) => [periodKey(d), { amount: this.toMoney(d._sum.amount), count: d._count._all }]),
    );
    const seenPeriodKeys = new Set(groups.map(periodKey));
    const buildPeriodItem = (
      targetMonth: number,
      academicYear: string,
      termStartMonth: number | null,
      amount: number,
      amountPaid: number,
      headCount: number,
    ) => {
      const termStart =
        termStartMonth ?? (classTerms.size ? [...classTerms.values()][0] : 8);
      return {
        target_month: targetMonth,
        academic_year: academicYear,
        period_label: getMonthYearLabel(targetMonth, academicYear, { termStartMonth: termStart }),
        head_count: headCount,
        amount,
        amount_paid: amountPaid,
        outstanding: this.roundMoney(amount - amountPaid),
      };
    };
    const items = groups.map((group) => {
      const discount = discountByPeriod.get(periodKey(group));
      const amount = this.roundMoney(this.toMoney(group._sum.amount) - (discount?.amount ?? 0));
      const amountPaid = this.toMoney(group._sum.amount_paid);
      return buildPeriodItem(
        group.target_month,
        group.academic_year,
        group.term_start_month,
        amount,
        amountPaid,
        group._count._all + (discount?.count ?? 0),
      );
    });
    // A period with only discount rows (no matching non-discount head this filter)
    // still needs its own row rather than being silently dropped.
    for (const disc of discGroups) {
      if (seenPeriodKeys.has(periodKey(disc))) continue;
      items.push(
        buildPeriodItem(
          disc.target_month,
          disc.academic_year,
          disc.term_start_month,
          -this.toMoney(disc._sum.amount),
          0,
          disc._count._all,
        ),
      );
    }
    items.sort((a, b) => a.academic_year.localeCompare(b.academic_year) || a.target_month - b.target_month);
    const start = (page - 1) * limit;

    return {
      view: 'period' as const,
      items: items.slice(start, start + limit),
      pagination: createPaginationMeta(page, limit, items.length),
      totals: {
        ...totals,
        student_count: studentCount,
        ...this.buildTotalsCheck(totals),
      },
    };
  }

  private async listFeeHeadsByClass(
    query: ListFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ) {
    const leaf = this.feeHeadsLeafWhere(query);
    const studentWhere = this.buildStudentWhere(query, user);
    const where: Prisma.student_feesWhereInput = {
      ...leaf,
      students: studentWhere,
    };
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 200);

    const [groups, discGroups, totals, studentCount] = await Promise.all([
      this.prisma.student_fees.groupBy({
        by: ['student_id'],
        where: { ...where, is_discount: false },
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
      }),
      this.prisma.student_fees.groupBy({
        by: ['student_id'],
        where: { ...where, is_discount: true },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.feeHeadMoneyTotals(where),
      this.prisma.students.count({
        where: { ...studentWhere, student_fees: { some: leaf } },
      }),
    ]);

    // Merge each student's discount total into their fee-head total before class
    // bucketing, so a class's amount is net-of-discount. Union both group sets so a
    // student with only a discount row (no fee head this filter) still gets a row.
    const perStudent = new Map<number, { amount: number; amountPaid: number; headCount: number }>();
    for (const group of groups) {
      perStudent.set(group.student_id, {
        amount: this.toMoney(group._sum.amount),
        amountPaid: this.toMoney(group._sum.amount_paid),
        headCount: group._count._all,
      });
    }
    for (const disc of discGroups) {
      const existing = perStudent.get(disc.student_id) ?? { amount: 0, amountPaid: 0, headCount: 0 };
      existing.amount = this.roundMoney(existing.amount - this.toMoney(disc._sum.amount));
      existing.headCount += disc._count._all;
      perStudent.set(disc.student_id, existing);
    }

    const studentIds = [...perStudent.keys()];
    const students = studentIds.length
      ? await this.prisma.students.findMany({
          where: { cc: { in: studentIds } },
          select: {
            cc: true,
            status: true,
            class_id: true,
            graduated_from_class_id: true,
            classes: { select: { id: true, description: true } },
            graduated_from_class: { select: { id: true, description: true } },
          },
        })
      : [];
    const studentMap = new Map(students.map((s) => [s.cc, s]));

    const classBuckets = new Map<
      number | 'unassigned',
      {
        class_id: number | null;
        class_name: string;
        student_count: number;
        head_count: number;
        amount: number;
        amount_paid: number;
        outstanding: number;
      }
    >();

    for (const [studentId, sums] of perStudent) {
      const student = studentMap.get(studentId);
      const effectiveClassId = this.effectiveClassId(student);
      const bucketKey = effectiveClassId ?? 'unassigned';
      const existing = classBuckets.get(bucketKey) ?? {
        class_id: effectiveClassId,
        class_name: this.resolveStudentClassName(student) || 'Unassigned',
        student_count: 0,
        head_count: 0,
        amount: 0,
        amount_paid: 0,
        outstanding: 0,
      };
      existing.student_count += 1;
      existing.head_count += sums.headCount;
      existing.amount = this.roundMoney(existing.amount + sums.amount);
      existing.amount_paid = this.roundMoney(existing.amount_paid + sums.amountPaid);
      existing.outstanding = this.roundMoney(existing.amount - existing.amount_paid);
      classBuckets.set(bucketKey, existing);
    }

    const items = [...classBuckets.values()].sort((a, b) =>
      a.class_name.localeCompare(b.class_name),
    );
    const start = (page - 1) * limit;

    return {
      view: 'class' as const,
      items: items.slice(start, start + limit),
      pagination: createPaginationMeta(page, limit, items.length),
      totals: {
        ...totals,
        student_count: studentCount,
        ...this.buildTotalsCheck(totals),
      },
    };
  }

  async listDeposits(query: ListDepositsQueryDto, user: IJwtStaffPayload) {
    this.assertDateRange(query);
    const where = this.buildDepositsWhere(query, user);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 200);

    const [rows, cash, byType, discounts, appliedDiscounts] = await Promise.all([
      this.prisma.deposits.findMany({
        where,
        select: DEPOSIT_SELECT,
        orderBy: [{ deposit_date: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.deposits.aggregate({
        where,
        _sum: { total_amount: true },
        _count: true,
      }),
      this.prisma.deposit_allocations.groupBy({
        by: ['type'],
        where: { deposits: where },
        _sum: { amount: true },
      }),
      this.depositsDiscountTotal(query, user),
      this.depositsAppliedDiscountTotal(query, user),
    ]);

    return {
      items: rows.map((row) => this.mapDeposit(row)),
      pagination: createPaginationMeta(page, limit, cash._count),
      totals: {
        ...this.buildDepositTotals(cash, byType),
        discounts_total: discounts.amount,
        discounts_count: discounts.count,
        discounts_applied_total: appliedDiscounts.amount,
        discounts_applied_count: appliedDiscounts.count,
      },
    };
  }

  async exportFeeHeads(
    query: ExportFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    this.assertDateRange(query);
    const view = query.view ?? 'heads';
    if (view === 'student') {
      return this.exportFeeHeadsByStudent(query, user);
    }
    if (view === 'fee_type') {
      return this.exportFeeHeadsByFeeType(query, user);
    }
    if (view === 'period') {
      return this.exportFeeHeadsByPeriod(query, user);
    }
    if (view === 'class') {
      return this.exportFeeHeadsByClass(query, user);
    }

    const where = this.buildFeeHeadsWhere(query, user);
    const [rows, classTerms] = await Promise.all([
      this.prisma.student_fees.findMany({
        where,
        select: FEE_HEAD_SELECT,
        orderBy: [{ fee_date: 'asc' }, { id: 'asc' }],
        take: EXPORT_ROW_CAP + 1,
      }),
      this.loadClassTerms(),
    ]);
    this.assertExportCap(rows.length);

    const items = rows.map((row) => this.mapFeeHead(row, classTerms));
    const columns: ExportColumn[] = [
      { header: 'CC', key: 'cc', width: 10 },
      { header: 'GR', key: 'gr_number', width: 12 },
      { header: 'Name', key: 'student_name', width: 28 },
      { header: 'Campus', key: 'campus', width: 18 },
      { header: 'Class', key: 'class_name', width: 16 },
      { header: 'Section', key: 'section', width: 12 },
      { header: 'Fee type', key: 'fee_type', width: 28 },
      { header: 'Period', key: 'period_label', width: 12 },
      { header: 'Fee date', key: 'fee_date', width: 14 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Amount', key: 'amount', width: 14 },
      { header: 'Amount paid', key: 'amount_paid', width: 14 },
      { header: 'Outstanding', key: 'outstanding', width: 14 },
    ];
    const data = items.map((item) => ({
      cc: item.cc,
      gr_number: item.gr_number ?? '',
      student_name: item.student_name,
      campus: item.campus,
      class_name: item.class_name,
      section: item.section,
      fee_type: item.fee_type,
      period_label: item.period_label,
      fee_date: item.fee_date ?? '',
      status: item.status ?? '',
      amount: item.amount,
      amount_paid: item.amount_paid,
      outstanding: item.outstanding,
    }));

    return this.buildExportFile(
      'Fee Heads',
      `fee-heads-report-${query.from_date}-to-${query.to_date}`,
      columns,
      data,
      query.format,
    );
  }

  private async exportFeeHeadsByStudent(
    query: ExportFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    const leaf = this.feeHeadsLeafWhere(query);
    const studentWhere = this.buildStudentWhere(query, user);
    const where: Prisma.student_feesWhereInput = {
      ...leaf,
      students: studentWhere,
    };
    const groups = await this.prisma.student_fees.groupBy({
      by: ['student_id'],
      where: { ...where, is_discount: false },
      _sum: { amount: true, amount_paid: true },
      _count: { _all: true },
      orderBy: { student_id: 'asc' },
      take: EXPORT_ROW_CAP + 1,
    });
    this.assertExportCap(groups.length);

    const studentIds = groups.map((g) => g.student_id);
    const [students, discGroups] = studentIds.length
      ? await Promise.all([
          this.prisma.students.findMany({
            where: { cc: { in: studentIds } },
            select: {
              cc: true,
              gr_number: true,
              full_name: true,
              status: true,
              class_id: true,
              graduated_from_class_id: true,
              campuses: { select: { campus_name: true } },
              classes: { select: { description: true } },
              graduated_from_class: { select: { description: true } },
              sections: { select: { description: true } },
            },
          }),
          this.prisma.student_fees.groupBy({
            by: ['student_id'],
            where: { ...where, is_discount: true, student_id: { in: studentIds } },
            _sum: { amount: true },
            _count: { _all: true },
          }),
        ])
      : [[], []];
    const studentMap = new Map(students.map((s) => [s.cc, s]));
    const discountByStudent = new Map(
      discGroups.map((d) => [d.student_id, { amount: this.toMoney(d._sum.amount), count: d._count._all }]),
    );
    const columns: ExportColumn[] = [
      { header: 'CC', key: 'cc', width: 10 },
      { header: 'GR', key: 'gr_number', width: 12 },
      { header: 'Name', key: 'student_name', width: 28 },
      { header: 'Campus', key: 'campus', width: 18 },
      { header: 'Class', key: 'class_name', width: 16 },
      { header: 'Section', key: 'section', width: 12 },
      { header: 'Heads', key: 'head_count', width: 10 },
      { header: 'Amount', key: 'amount', width: 14 },
      { header: 'Amount paid', key: 'amount_paid', width: 14 },
      { header: 'Outstanding', key: 'outstanding', width: 14 },
    ];
    const data = groups.map((group) => {
      const student = studentMap.get(group.student_id);
      const discount = discountByStudent.get(group.student_id);
      const billed = this.roundMoney(this.toMoney(group._sum.amount) - (discount?.amount ?? 0));
      const paid = this.toMoney(group._sum.amount_paid);
      return {
        cc: group.student_id,
        gr_number: student?.gr_number ?? '',
        student_name: student?.full_name ?? '',
        campus: student?.campuses?.campus_name ?? '',
        class_name: this.resolveStudentClassName(student),
        section: student?.sections?.description ?? '',
        head_count: group._count._all + (discount?.count ?? 0),
        amount: billed,
        amount_paid: paid,
        outstanding: this.roundMoney(billed - paid),
      };
    });

    return this.buildExportFile(
      'Fee Heads by Student',
      `fee-heads-by-student-${query.from_date}-to-${query.to_date}`,
      columns,
      data,
      query.format,
    );
  }

  private async exportFeeHeadsByFeeType(
    query: ExportFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    const result = await this.listFeeHeadsByFeeType(
      { ...query, page: 1, limit: EXPORT_ROW_CAP + 1 },
      user,
    );
    this.assertExportCap(result.items.length);
    const columns: ExportColumn[] = [
      { header: 'Fee type', key: 'fee_type', width: 32 },
      { header: 'Heads', key: 'head_count', width: 10 },
      { header: 'Amount', key: 'amount', width: 14 },
      { header: 'Amount paid', key: 'amount_paid', width: 14 },
      { header: 'Outstanding', key: 'outstanding', width: 14 },
    ];
    const data = result.items.map((item) => ({
      fee_type: item.fee_type,
      head_count: item.head_count,
      amount: item.amount,
      amount_paid: item.amount_paid,
      outstanding: item.outstanding,
    }));
    return this.buildExportFile(
      'Fee Heads by Type',
      `fee-heads-by-type-${query.from_date}-to-${query.to_date}`,
      columns,
      data,
      query.format,
    );
  }

  private async exportFeeHeadsByPeriod(
    query: ExportFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    const result = await this.listFeeHeadsByPeriod(
      { ...query, page: 1, limit: EXPORT_ROW_CAP + 1 },
      user,
    );
    this.assertExportCap(result.items.length);
    const columns: ExportColumn[] = [
      { header: 'Period', key: 'period_label', width: 14 },
      { header: 'Academic year', key: 'academic_year', width: 14 },
      { header: 'Heads', key: 'head_count', width: 10 },
      { header: 'Amount', key: 'amount', width: 14 },
      { header: 'Amount paid', key: 'amount_paid', width: 14 },
      { header: 'Outstanding', key: 'outstanding', width: 14 },
    ];
    const data = result.items.map((item) => ({
      period_label: item.period_label,
      academic_year: item.academic_year,
      head_count: item.head_count,
      amount: item.amount,
      amount_paid: item.amount_paid,
      outstanding: item.outstanding,
    }));
    return this.buildExportFile(
      'Fee Heads by Period',
      `fee-heads-by-period-${query.from_date}-to-${query.to_date}`,
      columns,
      data,
      query.format,
    );
  }

  private async exportFeeHeadsByClass(
    query: ExportFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    const result = await this.listFeeHeadsByClass(
      { ...query, page: 1, limit: EXPORT_ROW_CAP + 1 },
      user,
    );
    this.assertExportCap(result.items.length);
    const columns: ExportColumn[] = [
      { header: 'Class', key: 'class_name', width: 20 },
      { header: 'Students', key: 'student_count', width: 12 },
      { header: 'Heads', key: 'head_count', width: 10 },
      { header: 'Amount', key: 'amount', width: 14 },
      { header: 'Amount paid', key: 'amount_paid', width: 14 },
      { header: 'Outstanding', key: 'outstanding', width: 14 },
    ];
    const data = result.items.map((item) => ({
      class_name: item.class_name,
      student_count: item.student_count,
      head_count: item.head_count,
      amount: item.amount,
      amount_paid: item.amount_paid,
      outstanding: item.outstanding,
    }));
    return this.buildExportFile(
      'Fee Heads by Class',
      `fee-heads-by-class-${query.from_date}-to-${query.to_date}`,
      columns,
      data,
      query.format,
    );
  }

  async exportDeposits(
    query: ExportDepositsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    this.assertDateRange(query);
    const where = this.buildDepositsWhere(query, user);
    const rows = await this.prisma.deposits.findMany({
      where,
      select: DEPOSIT_SELECT,
      orderBy: [{ deposit_date: 'asc' }, { id: 'asc' }],
      take: EXPORT_ROW_CAP + 1,
    });
    this.assertExportCap(rows.length);

    const items = rows.map((row) => this.mapDeposit(row));
    const columns: ExportColumn[] = [
      { header: 'Deposit ID', key: 'id', width: 12 },
      { header: 'Deposit date', key: 'deposit_date', width: 20 },
      { header: 'CC', key: 'cc', width: 10 },
      { header: 'GR', key: 'gr_number', width: 12 },
      { header: 'Name', key: 'student_name', width: 28 },
      { header: 'Campus', key: 'campus', width: 18 },
      { header: 'Class', key: 'class_name', width: 16 },
      { header: 'Section', key: 'section', width: 12 },
      { header: 'Payment method', key: 'payment_method', width: 18 },
      { header: 'Bank', key: 'bank_name', width: 20 },
      { header: 'Reference', key: 'reference_number', width: 18 },
      { header: 'Total amount', key: 'total_amount', width: 14 },
      { header: 'Fee heads', key: 'fee_heads', width: 14 },
      { header: 'Late fee', key: 'late_fee', width: 14 },
      { header: 'Arrear surcharge', key: 'surcharge', width: 16 },
      { header: 'LPS total', key: 'lps_total', width: 14 },
    ];
    const data = items.map((item) => ({
      id: item.id,
      deposit_date: item.deposit_date,
      cc: item.cc,
      gr_number: item.gr_number ?? '',
      student_name: item.student_name,
      campus: item.campus,
      class_name: item.class_name,
      section: item.section,
      payment_method: item.payment_method ?? '',
      bank_name: item.bank_name ?? '',
      reference_number: item.reference_number ?? '',
      total_amount: item.total_amount,
      fee_heads: item.fee_heads,
      late_fee: item.late_fee,
      surcharge: item.surcharge,
      lps_total: item.lps_total,
    }));

    return this.buildExportFile(
      'Deposits',
      `deposits-report-${query.from_date}-to-${query.to_date}`,
      columns,
      data,
      query.format,
    );
  }

  /**
   * Rows = students, columns = every calendar month from from_month to
   * to_month inclusive, cells = the fee head(s) whose target_month resolves
   * (via each head's own term_start_month, falling back to its class) to
   * that calendar month. Excludes arrear (late payment) surcharges, same as
   * the Fee Heads report. Discount rows are included as negative-amount
   * cells (see signedAmount) so row/column/grand totals and the statistics
   * panel are net-of-discount. Column/grand totals and statistics cover
   * every student matching the filters, not just the current page —
   * pagination only limits which rows render.
   */
  async listFeeMatrix(query: ListFeeMatrixQueryDto, user: IJwtStaffPayload) {
    this.assertMonthRange(query);
    const from = this.parseYearMonth(query.from_month);
    const to = this.parseYearMonth(query.to_month);
    const columns = this.matrixMonthColumns(from, to);
    const candidateYears = this.matrixCandidateAcademicYears(columns);
    const leaf = this.matrixLeafWhere(query, candidateYears);
    const studentWhere = this.buildMatrixStudentWhere(query, user);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 25, 200);

    const [students, studentCount, classTerms] = await Promise.all([
      this.prisma.students.findMany({
        where: { ...studentWhere, student_fees: { some: leaf } },
        select: MATRIX_STUDENT_SELECT,
        orderBy: [{ full_name: 'asc' }, { cc: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.students.count({
        where: { ...studentWhere, student_fees: { some: leaf } },
      }),
      this.loadClassTerms(),
    ]);

    const ccs = students.map((s) => s.cc);
    const [pageHeads, allHeads] = await Promise.all([
      ccs.length
        ? this.prisma.student_fees.findMany({
            where: { ...leaf, student_id: { in: ccs } },
            select: MATRIX_HEAD_SELECT,
            orderBy: [{ fee_date: 'asc' }, { id: 'asc' }],
          })
        : Promise.resolve([]),
      // Every filtered head, independent of pagination — feeds column
      // totals, the grand total, and every statistic below.
      this.prisma.student_fees.findMany({
        where: { ...leaf, students: studentWhere },
        select: MATRIX_HEAD_SELECT,
        take: STATS_ROW_CAP,
      }),
    ]);

    const columnPosition = new Map<string, number>(
      columns.map((c, i) => [this.matrixMonthKey(c), i]),
    );
    const headsByStudent = this.groupHeadsByStudent(pageHeads);

    const items = students.map((student) => {
      const cells: MatrixCell[][] = Array.from({ length: columns.length }, () => []);
      let rowTotal = 0;
      for (const head of headsByStudent.get(student.cc) ?? []) {
        const resolved = this.resolveHeadCalendarMonth(head, classTerms);
        const columnIndex = resolved ? columnPosition.get(this.matrixMonthKey(resolved)) : undefined;
        if (columnIndex === undefined) continue;
        const amount = this.signedAmount(head);
        cells[columnIndex].push({
          id: head.id,
          fee_type: this.matrixFeeTypeLabel(head),
          amount,
          status: (head.status ?? fee_status_enum.NOT_ISSUED) as fee_status_enum,
        });
        rowTotal = this.roundMoney(rowTotal + amount);
      }
      return {
        cc: student.cc,
        gr_number: student.gr_number,
        student_name: student.full_name,
        campus: student.campuses?.campus_name ?? '',
        class_name: this.resolveStudentClassName(student),
        section: student.sections?.description ?? '',
        cells,
        row_total: rowTotal,
      };
    });

    // Restrict the (over-fetched, candidate-year) allHeads down to the heads
    // that actually resolve into the requested month range, before any
    // totals or statistics are computed from them.
    const columnTotals = new Array(columns.length).fill(0) as number[];
    const inRangeHeads: typeof allHeads = [];
    for (const head of allHeads) {
      const resolved = this.resolveHeadCalendarMonth(head, classTerms);
      const columnIndex = resolved ? columnPosition.get(this.matrixMonthKey(resolved)) : undefined;
      if (columnIndex === undefined) continue;
      inRangeHeads.push(head);
      columnTotals[columnIndex] = this.roundMoney(
        columnTotals[columnIndex] + this.signedAmount(head),
      );
    }
    const grandTotal = this.roundMoney(
      columnTotals.reduce((sum, value) => sum + value, 0),
    );

    const studentSums = new Map<number, number>();
    for (const head of inRangeHeads) {
      const amount = this.signedAmount(head);
      studentSums.set(
        head.student_id,
        this.roundMoney((studentSums.get(head.student_id) ?? 0) + amount),
      );
    }
    const studentTotals = [...studentSums.values()];
    const feeAmounts = inRangeHeads.map((h) => this.signedAmount(h));

    return {
      from_month: query.from_month,
      to_month: query.to_month,
      columns: columns.map((c) => ({
        year: c.year,
        month: c.month,
        label: this.formatColumnLabel(c),
      })),
      items,
      pagination: createPaginationMeta(page, limit, studentCount),
      totals: {
        student_count: studentCount,
        column_totals: columnTotals,
        grand_total: grandTotal,
      },
      /**
       * Every stat here is computed over the whole filtered set (all pages),
       * same scope as totals above — never just the rows on screen.
       */
      statistics: {
        student_totals: this.describeDistribution(studentTotals),
        fee_amounts: this.describeDistribution(feeAmounts),
        by_fee_type: this.buildFeeTypeStatistics(inRangeHeads),
        truncated: allHeads.length >= STATS_ROW_CAP,
      },
    };
  }

  async exportFeeMatrix(
    query: ExportFeeMatrixQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    this.assertMonthRange(query);
    const from = this.parseYearMonth(query.from_month);
    const to = this.parseYearMonth(query.to_month);
    const columns = this.matrixMonthColumns(from, to);
    const candidateYears = this.matrixCandidateAcademicYears(columns);
    const leaf = this.matrixLeafWhere(query, candidateYears);
    const studentWhere = this.buildMatrixStudentWhere(query, user);

    const [students, classTerms] = await Promise.all([
      this.prisma.students.findMany({
        where: { ...studentWhere, student_fees: { some: leaf } },
        select: MATRIX_STUDENT_SELECT,
        orderBy: [{ full_name: 'asc' }, { cc: 'asc' }],
        take: EXPORT_ROW_CAP + 1,
      }),
      this.loadClassTerms(),
    ]);
    this.assertExportCap(students.length);

    const ccs = students.map((s) => s.cc);
    const heads = ccs.length
      ? await this.prisma.student_fees.findMany({
          where: { ...leaf, student_id: { in: ccs } },
          select: MATRIX_HEAD_SELECT,
        })
      : [];
    const headsByStudent = this.groupHeadsByStudent(heads);

    const columnPosition = new Map<string, number>(
      columns.map((c, i) => [this.matrixMonthKey(c), i]),
    );
    const monthLabels = columns.map((c) => this.formatColumnLabel(c));
    const columnsSpec: ExportColumn[] = [
      { header: 'CC', key: 'cc', width: 10 },
      { header: 'GR', key: 'gr_number', width: 12 },
      { header: 'Name', key: 'student_name', width: 28 },
      { header: 'Campus', key: 'campus', width: 18 },
      { header: 'Class', key: 'class_name', width: 16 },
      { header: 'Section', key: 'section', width: 12 },
      ...columns.map((_, index) => ({
        header: monthLabels[index],
        key: `c${index}`,
        width: 24,
      })),
      { header: 'Total', key: 'row_total', width: 14 },
    ];

    const data = students.map((student) => {
      const studentHeads = headsByStudent.get(student.cc) ?? [];
      const row: Record<string, string | number> = {
        cc: student.cc,
        gr_number: student.gr_number ?? '',
        student_name: student.full_name,
        campus: student.campuses?.campus_name ?? '',
        class_name: this.resolveStudentClassName(student),
        section: student.sections?.description ?? '',
      };
      const perColumn: Array<{ label: string; amount: number }[]> = Array.from(
        { length: columns.length },
        () => [],
      );
      let rowTotal = 0;
      for (const head of studentHeads) {
        const resolved = this.resolveHeadCalendarMonth(head, classTerms);
        const columnIndex = resolved ? columnPosition.get(this.matrixMonthKey(resolved)) : undefined;
        if (columnIndex === undefined) continue;
        const amount = this.signedAmount(head);
        perColumn[columnIndex].push({ label: this.matrixFeeTypeLabel(head), amount });
        rowTotal = this.roundMoney(rowTotal + amount);
      }
      columns.forEach((_, index) => {
        row[`c${index}`] = perColumn[index]
          .map((h) => `${h.label}: ${h.amount.toLocaleString()}`)
          .join('; ');
      });
      row.row_total = rowTotal;
      return row;
    });

    return this.buildExportFile(
      'Fee Matrix',
      `fee-matrix-${query.from_month}-to-${query.to_month}`,
      columnsSpec,
      data,
      query.format,
    );
  }

  /**
   * Defaulters — students carrying arrears across multiple distinct months.
   *
   * THE DEFINITION HERE IS VouchersService.computeArrears (vouchers.service.ts
   * :5214) AND NOTHING ELSE. An arrear is an unpaid, non-discount fee head with
   * a fee_date strictly before as_of_date and outstanding > 0; "one month
   * behind" is one distinct (academic_year, target_month) pair among those
   * heads — the same key computeArrears groups on to decide how many Rs 1000
   * late payment surcharges the next voucher carries. So months_behind is also
   * the surcharge count that voucher would bill.
   *
   * Two other, mutually contradictory "arrears" definitions exist in this
   * codebase — students.service.ts:3399 (academic_year mismatch) and
   * analytics.service.ts:104 (due_date < today, ISSUED/PARTIALLY_PAID only,
   * which explicitly documents the former as wrong). This report matches
   * NEITHER, on purpose. Expect the numbers to differ from both.
   *
   * NOT_ISSUED heads count, matching the engine — but they mean the office
   * never billed the family, so they are also reported separately as
   * months_behind_unbilled rather than being silently folded into severity.
   */
  /**
   * Defaulters — students whose current voucher situation says they owe more
   * than the bill in front of them.
   *
   * A student appears here ONLY if one of two things is true of their active
   * (status not VOID, not PAID) vouchers — see defaulter-severity.ts for the
   * full rationale:
   *
   *   ARREARS  — an active voucher already carries voucher_arrear_surcharges
   *              rows, i.e. VouchersService.computeArrears found genuine
   *              earlier-fee_date arrears when that voucher was generated.
   *              months_behind = COUNT(DISTINCT arrear_year, arrear_month)
   *              across those rows — the exact count that determined the
   *              Rs 1000-per-month surcharge already charged on it.
   *   EXPIRING — an active voucher has a single fee_date (nothing bundled
   *              into it) and its own status is EXPIRED: the window to pay
   *              THIS bill lapsed, so it becomes an arrear the moment the
   *              next voucher rolls it forward. months_behind = 0 — this
   *              category is an early warning, not a severity level.
   *
   * This is deliberately NOT "any unpaid student_fees row dated before
   * as_of_date". That definition (the report's first version) double-counted
   * whole-year advance billing: a voucher that bills 12 months of tuition at
   * once, all sharing one fee_date, spreads across 12 different target_month
   * values and was being read as "12 months behind" the moment that ONE
   * fee_date passed — even though 11 of those months hadn't arrived yet. Such
   * a voucher is one bill, not twelve late payments, until the office
   * actually rolls it forward as an arrear on a follow-up voucher — at which
   * point voucher_arrear_surcharges rows get written and the ARREARS
   * category picks it up honestly, with the real count.
   */
  async listDefaulters(
    query: ListDefaultersQueryDto,
    user: IJwtStaffPayload,
    /**
     * Page-size ceiling. Defaults to the HTTP page cap; only exportDefaulters
     * raises it. Without this the export would silently emit 200 rows of a
     * 500-row list — the same clamp does exactly that to the Fee Heads rollup
     * exports today (they pass EXPORT_ROW_CAP+1 into methods that cap at 200).
     */
    options: { maxLimit?: number } = {},
  ) {
    const asOfDate = query.as_of_date ?? this.todayDateOnly();
    const stripMonths = Math.min(query.strip_months ?? 12, 24);
    const view = query.view ?? 'students';
    const minMonthsBehind = query.min_months_behind ?? 1;
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, options.maxLimit ?? 200);

    const asOf = this.parseYearMonthOfDate(asOfDate);
    const columns = view === 'students' ? this.stripMonthColumns(asOf, stripMonths) : [];

    // Step 1 — resolve the scoped student set through the SAME path every other
    // report uses. applyStudentScope throws ForbiddenException for out-of-scope
    // campus/class, and this is the only place that can happen: everything
    // below only ever sees ids that survived this filter.
    const studentWhere: Prisma.studentsWhereInput = {
      ...this.buildStudentWhere(query, user),
      ...(query.cc != null && { cc: query.cc }),
    };
    const scoped = await this.prisma.students.findMany({
      where: studentWhere,
      select: DEFAULTER_STUDENT_SELECT,
      take: SCOPE_ROW_CAP + 1,
    });
    // Throw rather than truncate — see loadDefaulterEligibility: a clipped
    // scoped set would silently drop eligible students and corrupt pagination
    // and every rollup denominator.
    if (scoped.length > SCOPE_ROW_CAP) {
      throw new BadRequestException(
        `This report is limited to ${SCOPE_ROW_CAP.toLocaleString()} students. Narrow the campus, class, or status filters.`,
      );
    }
    if (scoped.length === 0) {
      return this.emptyDefaultersResponse(asOfDate, stripMonths, view, columns, page, limit);
    }

    // Step 2 — the eligibility test: which of the scoped students have a
    // qualifying voucher, and why. This also produces months_behind and LPS
    // for every eligible student (not just the page) — there is no cheaper
    // way to know who belongs on the report than reading every scoped
    // student's active vouchers.
    const [eligibility, classTerms] = await Promise.all([
      this.loadDefaulterEligibility(scoped.map((s) => s.cc)),
      this.loadClassTerms(),
    ]);

    // Step 3 — money (arrears_outstanding, arrear_head_count, oldest/newest
    // arrear fee_date), only for students who passed step 2. Independent of
    // months_behind: an ARREARS student's outstanding is every unpaid head
    // dated before as_of; an EXPIRING student's outstanding is simply their
    // one expired voucher's own unpaid heads.
    const eligibleIds = [...eligibility.keys()];
    const money = await this.loadDefaulterMoney(eligibleIds, asOfDate);

    const studentByCc = new Map(scoped.map((s) => [s.cc, s]));
    let rows: DefaulterRow[] = [];
    for (const elig of eligibility.values()) {
      const student = studentByCc.get(elig.student_id);
      if (!student) continue;
      const moneyRow = money.get(elig.student_id) ?? EMPTY_MONEY;
      rows.push({
        ...elig,
        ...moneyRow,
        severity: bandForMonthsBehind(elig.months_behind, elig.category),
        student,
      });
    }

    // min_months_behind narrows ARREARS rows only. EXPIRING rows are
    // months_behind = 0 by construction — filtering them out by the same
    // threshold under the DEFAULT value of 1 would hide the exact
    // early-warning case that category exists to surface.
    if (minMonthsBehind > 1) {
      rows = rows.filter((r) => r.category === 'EXPIRING' || r.months_behind >= minMonthsBehind);
    }
    if (query.severity?.length) {
      const wanted = new Set(query.severity);
      rows = rows.filter((r) => wanted.has(r.severity));
    }

    const shared = {
      as_of_date: asOfDate,
      strip_months: stripMonths,
      view,
      columns: columns.map((c) => ({
        year: c.year,
        month: c.month,
        label: this.formatColumnLabel(c),
      })),
      totals: this.buildDefaulterTotals(rows, scoped.length),
      severity_distribution: this.buildSeverityDistribution(rows),
      truncated: false,
    };

    if (view === 'aging') {
      const items = this.buildAgingRows(rows, scoped.length);
      return {
        ...shared,
        items,
        pagination: createPaginationMeta(1, items.length || 1, items.length),
      };
    }

    if (view === 'by_class' || view === 'by_campus') {
      const all = this.buildDefaulterRollup(rows, scoped, view);
      return {
        ...shared,
        items: all.slice((page - 1) * limit, page * limit),
        pagination: createPaginationMeta(page, limit, all.length),
      };
    }

    // students view — sort the whole set, then hydrate only the page slice
    // with the strip and payment-behaviour figures.
    const sorted = this.sortDefaulterRows(rows, query.sort_by, query.sort_dir);
    const pageRows = sorted.slice((page - 1) * limit, page * limit);
    const items = await this.buildDefaulterStudentRows(pageRows, columns, classTerms, asOfDate);

    return {
      ...shared,
      items,
      pagination: createPaginationMeta(page, limit, sorted.length),
    };
  }

  /**
   * The eligibility test and its by-products (months_behind, LPS) for the
   * whole scoped set. See the listDefaulters docstring for what "eligible"
   * means and why it isn't just "some fee_date is in the past".
   *
   * A student who does not qualify is simply absent from the returned map —
   * there is no "0 months, not eligible" entry.
   *
   * status <> 'VOID' AND status <> 'PAID' ("active") is the same voucher set
   * throughout: VOID vouchers were superseded and their surcharge rows are
   * stale re-charges of the same arrear month (never cascade-deleted on
   * void, only on hard delete); PAID vouchers are resolved, their arrears
   * are no longer current.
   */
  private async loadDefaulterEligibility(
    ids: number[],
  ): Promise<Map<number, DefaulterEligibility>> {
    const result = new Map<number, DefaulterEligibility>();
    if (ids.length === 0) return result;

    const vouchers = await this.prisma.vouchers.findMany({
      where: { student_id: { in: ids }, status: { notIn: ['VOID', 'PAID'] } },
      select: {
        student_id: true,
        status: true,
        released_to_parent_at: true,
        voucher_arrear_surcharges: {
          select: {
            arrear_year: true,
            arrear_month: true,
            amount: true,
            amount_paid: true,
            waived: true,
          },
        },
      },
    });

    type Acc = {
      groups: Map<string, true>;
      hasExpiringSingleVoucher: boolean;
      lpsCharged: number;
      lpsPaid: number;
      lpsWaived: number;
      unreleasedVoucherCount: number;
    };
    const byStudent = new Map<number, Acc>();

    for (const voucher of vouchers) {
      const acc = byStudent.get(voucher.student_id) ?? {
        groups: new Map<string, true>(),
        hasExpiringSingleVoucher: false,
        lpsCharged: 0,
        lpsPaid: 0,
        lpsWaived: 0,
        unreleasedVoucherCount: 0,
      };
      byStudent.set(voucher.student_id, acc);

      if (voucher.released_to_parent_at == null) {
        // Billed but never shown to the parent. Still counts toward
        // eligibility and LPS (it IS charged) — surfaced separately so staff
        // can see whose arrears are the office's fault, not the family's.
        acc.unreleasedVoucherCount += 1;
      }

      if (voucher.voucher_arrear_surcharges.length === 0) {
        // A single-fee_date voucher: nothing was rolled forward into it.
        // Only EXPIRED means "expired" literally — OVERDUE (due date passed,
        // still inside the validity window) is not the same thing yet.
        if (voucher.status === 'EXPIRED') acc.hasExpiringSingleVoucher = true;
        continue;
      }
      for (const s of voucher.voucher_arrear_surcharges) {
        acc.groups.set(`${s.arrear_year}_${s.arrear_month}`, true);
        if (s.waived) {
          acc.lpsWaived = this.roundMoney(acc.lpsWaived + this.toMoney(s.amount));
        } else {
          acc.lpsCharged = this.roundMoney(acc.lpsCharged + this.toMoney(s.amount));
          acc.lpsPaid = this.roundMoney(acc.lpsPaid + this.toMoney(s.amount_paid));
        }
      }
    }

    for (const [studentId, acc] of byStudent) {
      const monthsBehind = acc.groups.size;
      const category: DefaulterCategory | null =
        monthsBehind > 0 ? 'ARREARS' : acc.hasExpiringSingleVoucher ? 'EXPIRING' : null;
      if (!category) continue;
      result.set(studentId, {
        student_id: studentId,
        category,
        months_behind: monthsBehind,
        arrear_group_keys: [...acc.groups.keys()],
        lps_charged: acc.lpsCharged,
        lps_paid: acc.lpsPaid,
        lps_outstanding: this.roundMoney(Math.max(0, acc.lpsCharged - acc.lpsPaid)),
        lps_waived: acc.lpsWaived,
        unreleased_voucher_count: acc.unreleasedVoucherCount,
      });
    }
    return result;
  }

  /**
   * Money for a set of already-eligible students: every unpaid, non-discount
   * head dated before as_of. Independent of months_behind —
   * loadDefaulterEligibility answers "does this student belong on the report
   * and how many months"; this answers "how much".
   */
  private async loadDefaulterMoney(
    ids: number[],
    asOfDate: string,
  ): Promise<Map<number, DefaulterMoney>> {
    const result = new Map<number, DefaulterMoney>();
    if (ids.length === 0) return result;

    const rows = await this.prisma.$queryRaw<DefaulterMoneyRaw[]>(Prisma.sql`
      SELECT sf.student_id,
             SUM(COALESCE(sf.amount, sf.amount_before_discount, 0) - COALESCE(sf.amount_paid, 0))::float8
               AS arrears_outstanding,
             COUNT(*)::int AS arrear_head_count,
             MIN(sf.fee_date) AS oldest_arrear_fee_date,
             MAX(sf.fee_date) AS newest_arrear_fee_date
      FROM public.student_fees sf
      WHERE sf.student_id IN (${Prisma.join(ids)})
        AND sf.fee_date IS NOT NULL
        AND sf.fee_date < ${asOfDate}::date
        AND sf.is_arrear_surcharge = false
        AND sf.is_discount = false
        AND sf.status <> 'PAID'
        AND sf.status <> 'DISCOUNT'
        AND COALESCE(sf.amount, sf.amount_before_discount, 0) - COALESCE(sf.amount_paid, 0) > 0
      GROUP BY sf.student_id
    `);

    for (const r of rows) {
      result.set(Number(r.student_id), {
        arrears_outstanding: this.roundMoney(Number(r.arrears_outstanding ?? 0)),
        arrear_head_count: Number(r.arrear_head_count),
        oldest_arrear_fee_date: r.oldest_arrear_fee_date,
        newest_arrear_fee_date: r.newest_arrear_fee_date,
      });
    }
    return result;
  }

  /** The strip_months calendar months ending at (and including) the as-of month. */
  private stripMonthColumns(
    asOf: { year: number; month: number },
    stripMonths: number,
  ): Array<{ year: number; month: number }> {
    const span = Math.min(Math.max(stripMonths, 1), MATRIX_MAX_MONTHS);
    let year = asOf.year;
    let month = asOf.month - (span - 1);
    while (month <= 0) {
      month += 12;
      year -= 1;
    }
    return this.matrixMonthColumns({ year, month }, asOf);
  }

  /** amount ?? amount_before_discount ?? 0, minus amount_paid — the engine's formula. */
  private headOutstanding(head: {
    amount: Prisma.Decimal | null;
    amount_before_discount: Prisma.Decimal | null;
    amount_paid: Prisma.Decimal | null;
  }): number {
    const gross = this.toMoney(head.amount ?? head.amount_before_discount ?? 0);
    return this.roundMoney(gross - this.toMoney(head.amount_paid));
  }

  /**
   * Hydrate the page slice: the month strip and payment behaviour. LPS is
   * already on each row from loadDefaulterEligibility — no separate fetch.
   */
  private async buildDefaulterStudentRows(
    pageRows: DefaulterRow[],
    columns: Array<{ year: number; month: number }>,
    classTerms: ReadonlyMap<number, number>,
    asOfDate: string,
  ) {
    const ccs = pageRows.map((r) => r.student_id);
    if (ccs.length === 0) return [];

    // The strip resolves heads by term-aware (target_month, academic_year),
    // which cannot be filtered in SQL, so over-fetch by candidate academic
    // years and narrow in JS, exactly as listFeeMatrix does.
    const candidateYears = this.matrixCandidateAcademicYears(columns);
    const [heads, payments] = await Promise.all([
      columns.length
        ? this.prisma.student_fees.findMany({
            where: {
              student_id: { in: ccs },
              is_arrear_surcharge: false,
              academic_year: { in: candidateYears },
            },
            select: DEFAULTER_HEAD_SELECT,
            orderBy: [{ fee_date: 'asc' }, { id: 'asc' }],
          })
        : Promise.resolve([]),
      this.loadDefaulterPaymentBehaviour(ccs, asOfDate),
    ]);

    const headsByStudent = this.groupHeadsByStudent(heads);
    const asOfMs = this.parseLocalDayStart(asOfDate).getTime();

    return pageRows.map((row) => {
      const student = row.student;
      const pay = payments.get(row.student_id) ?? EMPTY_PAYMENTS;
      const ledgerGroups = new Set(row.arrear_group_keys);
      const { cells: strip, ledgerGroupsPlaced } = this.buildStripCells(
        headsByStudent.get(row.student_id) ?? [],
        columns,
        classTerms,
        ledgerGroups,
      );
      const lastPaymentDate = pay.last_payment_date;

      return {
        cc: student.cc,
        gr_number: student.gr_number,
        student_name: student.full_name,
        campus: student.campuses?.campus_name ?? '',
        class_name: this.resolveStudentClassName(student),
        section: student.sections?.description ?? '',
        student_status: student.status,
        is_fee_endowment: student.is_fee_endowment,
        is_complementary: student.is_complementary,

        category: row.category,
        months_behind: row.months_behind,
        severity: row.severity,

        arrears_outstanding: row.arrears_outstanding,
        arrear_head_count: row.arrear_head_count,
        oldest_arrear_fee_date: this.formatDateOnly(row.oldest_arrear_fee_date),
        oldest_arrear_month_label: this.oldestArrearMonthLabel(
          row.arrear_group_keys,
          this.effectiveClassId(student),
          classTerms,
        ),

        lps_charged: row.lps_charged,
        lps_paid: row.lps_paid,
        lps_outstanding: row.lps_outstanding,
        lps_waived: row.lps_waived,
        lps_projected_next_voucher: this.roundMoney(row.months_behind * LPS_PER_ARREAR_MONTH),
        unreleased_voucher_count: row.unreleased_voucher_count,

        last_payment_date: this.formatDateTimeOrNull(lastPaymentDate),
        days_since_last_payment: lastPaymentDate
          ? Math.max(0, Math.floor((asOfMs - lastPaymentDate.getTime()) / 86_400_000))
          : null,
        payments_last_6m: pay.payments_last_6m,
        paid_last_6m: pay.paid_last_6m,
        payments_last_12m: pay.payments_last_12m,
        paid_last_12m: pay.paid_last_12m,

        strip,
        /**
         * The strip window is backward-looking from as_of_date, but an arrear
         * group's target_month can fall outside it — a whole year billed on
         * one fee_date carries target months across the year, and once that
         * fee_date rolls into a follow-up voucher as an arrear (ARREARS
         * category), all of those months are "behind" even though most of
         * them are older than a 12-month strip. Report the shortfall rather
         * than letting the strip quietly show fewer red cells than
         * months_behind without explanation.
         */
        arrear_months_in_window: ledgerGroupsPlaced,
        arrear_months_outside_window: Math.max(0, row.months_behind - ledgerGroupsPlaced),
      };
    });
  }

  /**
   * One cell per calendar column, from the heads that resolve into it.
   *
   * is_arrear is driven by the student's ledger arrear_group_keys (real
   * voucher_arrear_surcharges rows, from loadDefaulterEligibility) — NOT by
   * "this head's fee_date is in the past and unpaid". That decoupling is the
   * whole point: a head can be unpaid and dated before as_of yet never have
   * been rolled into a voucher as an arrear (e.g. one month of a 12-month
   * advance bill that hasn't been superseded yet) — that cell renders
   * unpaid/grey, not red, matching the eligibility rule exactly.
   *
   * Discounts are excluded from cell state — their amount is stored POSITIVE
   * with inverted meaning and only signedAmount flips it; this path does not
   * go through signedAmount, and a discount is never an arrear.
   */
  private buildStripCells(
    heads: DefaulterHead[],
    columns: Array<{ year: number; month: number }>,
    classTerms: ReadonlyMap<number, number>,
    ledgerGroups: ReadonlySet<string>,
  ): { cells: StripCell[]; ledgerGroupsPlaced: number } {
    const position = new Map<string, number>(
      columns.map((c, i) => [this.matrixMonthKey(c), i]),
    );
    const cells: StripCell[] = columns.map((c) => ({
      year: c.year,
      month: c.month,
      state: 'not_billed',
      is_arrear: false,
      amount: 0,
      outstanding: 0,
      head_count: 0,
      group_keys: [],
    }));
    const anyPaid = new Array(columns.length).fill(false) as boolean[];
    const placed = new Set<string>();

    for (const head of heads) {
      if (head.is_discount) continue;
      const resolved = this.resolveHeadCalendarMonth(head, classTerms);
      const index = resolved ? position.get(this.matrixMonthKey(resolved)) : undefined;
      if (index === undefined) continue;

      const cell = cells[index];
      const outstanding = this.headOutstanding(head);
      cell.head_count += 1;
      cell.amount = this.roundMoney(
        cell.amount + this.toMoney(head.amount ?? head.amount_before_discount ?? 0),
      );
      cell.outstanding = this.roundMoney(cell.outstanding + Math.max(0, outstanding));
      if (this.toMoney(head.amount_paid) > 0) anyPaid[index] = true;

      const key = `${head.academic_year}_${head.target_month}`;
      if (!cell.group_keys.includes(key)) cell.group_keys.push(key);
      if (ledgerGroups.has(key)) {
        cell.is_arrear = true;
        placed.add(key);
      }
    }

    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      if (cell.head_count === 0) continue;
      if (cell.outstanding <= 0) cell.state = 'paid';
      else if (anyPaid[i]) cell.state = 'partial';
      else cell.state = 'unpaid';
    }
    return { cells, ledgerGroupsPlaced: placed.size };
  }

  /**
   * Term-aware label for the earliest arrear month, e.g. "Aug 25" — derived
   * straight from the ledger's arrear_group_keys ("<academic_year>_<month>"
   * strings), not by scanning heads. The ledger is the authority on which
   * months are arrears; a head-scan could disagree with it.
   */
  private oldestArrearMonthLabel(
    arrearGroupKeys: string[],
    classId: number | null,
    classTerms: ReadonlyMap<number, number>,
  ): string | null {
    const term = termOfHead(null, { classId, classTerms });
    let best: { academicYear: string; month: number; index: number } | null = null;
    for (const key of arrearGroupKeys) {
      const sep = key.lastIndexOf('_');
      if (sep <= 0) continue;
      const academicYear = key.slice(0, sep);
      const month = Number(key.slice(sep + 1));
      if (!Number.isFinite(month)) continue;
      const index = monthAbsoluteIndex(month, academicYear, term);
      if (index == null) continue;
      if (!best || index < best.index) best = { academicYear, month, index };
    }
    if (!best) return null;
    return getMonthYearLabel(best.month, best.academicYear, term);
  }

  /**
   * Last payment, plus 6- and 12-month payment counts, for the page slice.
   *
   * date_of_return: null is a DELIBERATE divergence from buildDepositsWhere,
   * which does not filter returned deposits. A bounced cheque is not a payment,
   * and "last paid 3 days ago" off a returned cheque would actively mislead a
   * recovery call.
   *
   * No on-time rate here: it needs deposit_allocations -> student_fees.due_date
   * per student, which is why students.service.ts:3410 can afford it for one
   * student and a list endpoint cannot.
   */
  private async loadDefaulterPaymentBehaviour(
    ids: number[],
    asOfDate: string,
  ): Promise<Map<number, PaymentBehaviour>> {
    const result = new Map<number, PaymentBehaviour>();
    if (ids.length === 0) return result;

    // deposit_date is a Timestamp, not a Date — an lte on midnight would drop
    // the whole final day. Same bound listDeposits uses.
    const upper = this.parseLocalDayAfter(asOfDate);
    const since = (months: number) => {
      const d = this.parseLocalDayStart(asOfDate);
      d.setMonth(d.getMonth() - months);
      return d;
    };
    const base: Prisma.depositsWhereInput = {
      student_id: { in: ids },
      date_of_return: null,
      deposit_date: { lt: upper },
    };
    const window = (months: number): Prisma.depositsWhereInput => ({
      ...base,
      deposit_date: { gte: since(months), lt: upper },
    });

    const [allTime, last6, last12] = await Promise.all([
      this.prisma.deposits.groupBy({
        by: ['student_id'],
        where: base,
        _max: { deposit_date: true },
      }),
      this.prisma.deposits.groupBy({
        by: ['student_id'],
        where: window(6),
        _count: { _all: true },
        _sum: { total_amount: true },
      }),
      this.prisma.deposits.groupBy({
        by: ['student_id'],
        where: window(12),
        _count: { _all: true },
        _sum: { total_amount: true },
      }),
    ]);

    const entry = (cc: number) => {
      const existing = result.get(cc) ?? { ...EMPTY_PAYMENTS };
      result.set(cc, existing);
      return existing;
    };
    for (const row of allTime) {
      entry(row.student_id).last_payment_date = row._max.deposit_date ?? null;
    }
    for (const row of last6) {
      const e = entry(row.student_id);
      e.payments_last_6m = row._count._all;
      e.paid_last_6m = this.toMoney(row._sum.total_amount);
    }
    for (const row of last12) {
      const e = entry(row.student_id);
      e.payments_last_12m = row._count._all;
      e.paid_last_12m = this.toMoney(row._sum.total_amount);
    }
    return result;
  }

  private sortDefaulterRows(
    rows: DefaulterRow[],
    sortBy: DefaulterSortField | undefined,
    sortDir: 'asc' | 'desc' | undefined,
  ): DefaulterRow[] {
    const field = sortBy ?? 'months_behind';
    const dir = (sortDir ?? 'desc') === 'asc' ? 1 : -1;
    const value = (row: DefaulterRow): number | string => {
      switch (field) {
        case 'arrears_outstanding':
          return row.arrears_outstanding;
        case 'arrear_head_count':
          return row.arrear_head_count;
        case 'oldest_arrear':
          return row.oldest_arrear_fee_date?.getTime() ?? Number.POSITIVE_INFINITY;
        case 'student_name':
          return row.student.full_name ?? '';
        default:
          return row.months_behind;
      }
    };
    return [...rows].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv)) * dir;
      }
      // Stable tiebreak so pagination cannot reshuffle rows between pages.
      if (av !== bv) return (av - bv) * dir;
      return a.student_id - b.student_id;
    });
  }

  /**
   * Every figure here is computed over the WHOLE filtered set, never the page.
   *
   * in_scope_students is the full scoped student count from step 1, NOT the
   * defaulter count, so defaulter_rate answers "what share of these students
   * are behind (or about to be)".
   *
   * months_behind_avg/max and months_behind_distribution run over ARREARS
   * rows only — folding in EXPIRING's guaranteed zeros would describe a
   * different question ("how far behind is the average defaulter" vs. "how
   * far behind is the average row on this page, most of which are 0").
   */
  private buildDefaulterTotals(rows: DefaulterRow[], inScopeStudents: number) {
    const arrearsRows = rows.filter((r) => r.category === 'ARREARS');
    const monthsBehind = arrearsRows.map((r) => r.months_behind);
    const arrears = rows.map((r) => r.arrears_outstanding);
    const monthsTotal = monthsBehind.reduce((a, b) => a + b, 0);
    const counts = this.countBySeverity(rows);
    const sum = (f: (r: DefaulterRow) => number) =>
      this.roundMoney(rows.reduce((a, r) => a + f(r), 0));

    return {
      in_scope_students: inScopeStudents,
      defaulter_count: rows.length,
      defaulter_rate: this.percentage(rows.length, inScopeStudents),

      expiring_count: counts.EXPIRING,
      watch_count: counts.WATCH,
      defaulter_band_count: counts.DEFAULTER,
      severe_count: counts.SEVERE,
      critical_count: counts.CRITICAL,

      arrears_outstanding: sum((r) => r.arrears_outstanding),
      arrear_head_count: rows.reduce((a, r) => a + r.arrear_head_count, 0),

      months_behind_total: monthsTotal,
      months_behind_avg: arrearsRows.length
        ? Math.round((monthsTotal / arrearsRows.length) * 10) / 10
        : 0,
      months_behind_max: monthsBehind.length ? Math.max(...monthsBehind) : 0,

      lps_charged: sum((r) => r.lps_charged),
      lps_paid: sum((r) => r.lps_paid),
      lps_outstanding: sum((r) => r.lps_outstanding),
      lps_waived: sum((r) => r.lps_waived),
      lps_projected_next_voucher: this.roundMoney(monthsTotal * LPS_PER_ARREAR_MONTH),

      arrears_distribution: this.describeDistribution(arrears),
      months_behind_distribution: this.describeDistribution(monthsBehind),
    };
  }

  private buildSeverityDistribution(rows: DefaulterRow[]) {
    return SEVERITY_BANDS.map((band) => {
      const inBand = rows.filter((r) => r.severity === band.id);
      const months = inBand.reduce((a, r) => a + r.months_behind, 0);
      return {
        band: band.id,
        label: band.label,
        student_count: inBand.length,
        arrears_outstanding: this.roundMoney(
          inBand.reduce((a, r) => a + r.arrears_outstanding, 0),
        ),
        lps_projected: this.roundMoney(months * LPS_PER_ARREAR_MONTH),
      };
    });
  }

  /** All five bands are always emitted (EXPIRING included) — a zero row is information. */
  private buildAgingRows(rows: DefaulterRow[], inScopeStudents: number) {
    return SEVERITY_BANDS.map((band) => {
      const inBand = rows.filter((r) => r.severity === band.id);
      const arrears = inBand.map((r) => r.arrears_outstanding);
      const total = this.roundMoney(arrears.reduce((a, b) => a + b, 0));
      const months = inBand.reduce((a, r) => a + r.months_behind, 0);
      return {
        band: band.id,
        label: band.label,
        months_behind_label: SEVERITY_BAND_LABELS[band.id],
        student_count: inBand.length,
        share_of_defaulters: this.percentage(inBand.length, rows.length),
        share_of_in_scope: this.percentage(inBand.length, inScopeStudents),
        arrears_outstanding: total,
        arrears_avg: inBand.length ? this.roundMoney(total / inBand.length) : 0,
        arrears_max: arrears.length ? Math.max(...arrears) : 0,
        lps_projected: this.roundMoney(months * LPS_PER_ARREAR_MONTH),
      };
    });
  }

  /**
   * Class/campus rollup. The denominator is every scoped student in the group,
   * including non-defaulters, so defaulter_rate is comparable across groups of
   * different sizes.
   */
  private buildDefaulterRollup(
    rows: DefaulterRow[],
    scoped: DefaulterStudent[],
    view: 'by_class' | 'by_campus',
  ) {
    const keyOf = (student: DefaulterStudent): { id: number | null; name: string } =>
      view === 'by_campus'
        ? { id: student.campus_id ?? null, name: student.campuses?.campus_name ?? 'Unassigned' }
        : {
            id: this.effectiveClassId(student),
            name: this.resolveStudentClassName(student) || 'Unassigned',
          };

    const groups = new Map<
      string,
      { id: number | null; name: string; inScope: number; rows: DefaulterRow[] }
    >();
    for (const student of scoped) {
      const { id, name } = keyOf(student);
      const key = String(id ?? `name:${name}`);
      const group = groups.get(key) ?? { id, name, inScope: 0, rows: [] };
      group.inScope += 1;
      groups.set(key, group);
    }
    for (const row of rows) {
      const { id, name } = keyOf(row.student);
      const key = String(id ?? `name:${name}`);
      const group = groups.get(key) ?? { id, name, inScope: 0, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }

    return [...groups.values()]
      .filter((g) => g.rows.length > 0)
      .map((g) => {
        const months = g.rows.map((r) => r.months_behind);
        const monthsTotal = months.reduce((a, b) => a + b, 0);
        const arrearsRowCount = g.rows.filter((r) => r.category === 'ARREARS').length;
        const arrears = this.roundMoney(
          g.rows.reduce((a, r) => a + r.arrears_outstanding, 0),
        );
        const counts = this.countBySeverity(g.rows);
        return {
          ...(view === 'by_campus'
            ? { campus_id: g.id, campus: g.name }
            : { class_id: g.id, class_name: g.name }),
          in_scope_students: g.inScope,
          defaulter_count: g.rows.length,
          defaulter_rate: this.percentage(g.rows.length, g.inScope),
          band_counts: counts,
          months_behind_total: monthsTotal,
          months_behind_avg: arrearsRowCount
            ? Math.round((monthsTotal / arrearsRowCount) * 10) / 10
            : 0,
          months_behind_max: months.length ? Math.max(...months) : 0,
          arrears_outstanding: arrears,
          arrears_avg: this.roundMoney(arrears / g.rows.length),
          lps_projected: this.roundMoney(monthsTotal * LPS_PER_ARREAR_MONTH),
        };
      })
      .sort((a, b) => b.defaulter_count - a.defaulter_count);
  }

  private countBySeverity(rows: DefaulterRow[]): Record<SeverityBand, number> {
    const counts: Record<SeverityBand, number> = {
      EXPIRING: 0,
      WATCH: 0,
      DEFAULTER: 0,
      SEVERE: 0,
      CRITICAL: 0,
    };
    for (const row of rows) counts[row.severity] += 1;
    return counts;
  }

  /** One decimal, 0 when the denominator is 0. */
  private percentage(part: number, whole: number): number {
    if (!whole) return 0;
    return Math.round((part / whole) * 1000) / 10;
  }

  private emptyDefaultersResponse(
    asOfDate: string,
    stripMonths: number,
    view: DefaulterView,
    columns: Array<{ year: number; month: number }>,
    page: number,
    limit: number,
  ) {
    return {
      as_of_date: asOfDate,
      strip_months: stripMonths,
      view,
      columns: columns.map((c) => ({
        year: c.year,
        month: c.month,
        label: this.formatColumnLabel(c),
      })),
      items: view === 'aging' ? this.buildAgingRows([], 0) : [],
      pagination: createPaginationMeta(page, limit, 0),
      totals: this.buildDefaulterTotals([], 0),
      severity_distribution: this.buildSeverityDistribution([]),
      truncated: false,
    };
  }

  /** Local calendar date, not UTC — "today" must mean the school's today. */
  private todayDateOnly(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;
  }

  private parseYearMonthOfDate(value: string): { year: number; month: number } {
    const [year, month] = value.split('-').map(Number);
    return { year, month };
  }

  private formatDateTimeOrNull(value: Date | null): string | null {
    return value ? this.formatDateTime(value) : null;
  }

  /**
   * Flat rows per view. The month strip is deliberately not exported — a
   * spreadsheet of 12 colour codes is unreadable, and every figure it encodes
   * (months behind, oldest arrear, outstanding) is already its own column.
   */
  async exportDefaulters(
    query: ExportDefaultersQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    const view = query.view ?? 'students';
    const data = await this.listDefaulters(
      {
        ...query,
        // Aging always returns exactly five rows; the others page.
        page: 1,
        limit: view === 'aging' ? 50 : EXPORT_ROW_CAP + 1,
        // The strip costs a full head fetch per row and is not exported.
        strip_months: 1,
      } as ListDefaultersQueryDto,
      user,
      { maxLimit: EXPORT_ROW_CAP + 1 },
    );

    const items = data.items as Array<Record<string, unknown>>;
    this.assertExportCap(items.length);
    const basename = `defaulters-${view}-as-of-${data.as_of_date}`;

    if (view === 'aging') {
      return this.buildExportFile(
        'Defaulters Aging',
        basename,
        [
          { header: 'Band', key: 'band', width: 14 },
          { header: 'Months Behind', key: 'months', width: 14 },
          { header: 'Students', key: 'students', width: 12 },
          { header: '% of Defaulters', key: 'share_def', width: 16 },
          { header: '% of In Scope', key: 'share_scope', width: 16 },
          { header: 'Arrears Outstanding', key: 'arrears', width: 20 },
          { header: 'Arrears Avg', key: 'arrears_avg', width: 16 },
          { header: 'Arrears Max', key: 'arrears_max', width: 16 },
          { header: 'LPS Projected', key: 'lps', width: 16 },
        ],
        items.map((r) => ({
          band: String(r.label),
          months: String(r.months_behind_label),
          students: Number(r.student_count),
          share_def: Number(r.share_of_defaulters),
          share_scope: Number(r.share_of_in_scope),
          arrears: Number(r.arrears_outstanding),
          arrears_avg: Number(r.arrears_avg),
          arrears_max: Number(r.arrears_max),
          lps: Number(r.lps_projected),
        })),
        query.format,
      );
    }

    if (view === 'by_class' || view === 'by_campus') {
      const isCampus = view === 'by_campus';
      return this.buildExportFile(
        isCampus ? 'Defaulters by Campus' : 'Defaulters by Class',
        basename,
        [
          { header: isCampus ? 'Campus' : 'Class', key: 'group', width: 26 },
          { header: 'Students In Scope', key: 'in_scope', width: 18 },
          { header: 'Defaulters', key: 'defaulters', width: 12 },
          { header: 'Defaulter Rate %', key: 'rate', width: 16 },
          { header: 'Expiring', key: 'expiring', width: 12 },
          { header: 'Watch (1m)', key: 'watch', width: 12 },
          { header: 'Defaulter (2m)', key: 'defaulter', width: 14 },
          { header: 'Severe (3m)', key: 'severe', width: 12 },
          { header: 'Critical (4m+)', key: 'critical', width: 14 },
          { header: 'Avg Months Behind', key: 'avg_months', width: 18 },
          { header: 'Max Months Behind', key: 'max_months', width: 18 },
          { header: 'Arrears Outstanding', key: 'arrears', width: 20 },
          { header: 'Arrears Avg', key: 'arrears_avg', width: 16 },
          { header: 'LPS Projected', key: 'lps', width: 16 },
        ],
        items.map((r) => {
          const bands = r.band_counts as Record<SeverityBand, number>;
          return {
            group: String((isCampus ? r.campus : r.class_name) ?? ''),
            in_scope: Number(r.in_scope_students),
            defaulters: Number(r.defaulter_count),
            rate: Number(r.defaulter_rate),
            expiring: bands.EXPIRING,
            watch: bands.WATCH,
            defaulter: bands.DEFAULTER,
            severe: bands.SEVERE,
            critical: bands.CRITICAL,
            avg_months: Number(r.months_behind_avg),
            max_months: Number(r.months_behind_max),
            arrears: Number(r.arrears_outstanding),
            arrears_avg: Number(r.arrears_avg),
            lps: Number(r.lps_projected),
          };
        }),
        query.format,
      );
    }

    return this.buildExportFile(
      'Defaulters',
      basename,
      [
        { header: 'CC', key: 'cc', width: 10 },
        { header: 'GR Number', key: 'gr', width: 14 },
        { header: 'Student', key: 'name', width: 28 },
        { header: 'Campus', key: 'campus', width: 18 },
        { header: 'Class', key: 'class', width: 16 },
        { header: 'Section', key: 'section', width: 12 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Category', key: 'category', width: 12 },
        { header: 'Severity', key: 'severity', width: 12 },
        { header: 'Months Behind', key: 'months', width: 14 },
        { header: 'Oldest Arrear', key: 'oldest', width: 14 },
        { header: 'Arrear Heads', key: 'heads', width: 13 },
        { header: 'Arrears Outstanding', key: 'arrears', width: 20 },
        { header: 'LPS Charged', key: 'lps_charged', width: 14 },
        { header: 'LPS Paid', key: 'lps_paid', width: 12 },
        { header: 'LPS Outstanding', key: 'lps_out', width: 16 },
        { header: 'LPS Waived', key: 'lps_waived', width: 13 },
        { header: 'LPS Next Voucher', key: 'lps_next', width: 17 },
        { header: 'Unreleased Vouchers', key: 'unreleased', width: 19 },
        { header: 'Last Payment', key: 'last_payment', width: 14 },
        { header: 'Days Since Payment', key: 'days_since', width: 18 },
        { header: 'Payments (6m)', key: 'pay6', width: 14 },
        { header: 'Payments (12m)', key: 'pay12', width: 14 },
      ],
      items.map((r) => ({
        cc: Number(r.cc),
        gr: String(r.gr_number ?? ''),
        name: String(r.student_name ?? ''),
        campus: String(r.campus ?? ''),
        class: String(r.class_name ?? ''),
        section: String(r.section ?? ''),
        status: String(r.student_status ?? ''),
        category: String(r.category ?? ''),
        severity: String(r.severity),
        months: Number(r.months_behind),
        oldest: String(r.oldest_arrear_fee_date ?? ''),
        heads: Number(r.arrear_head_count),
        arrears: Number(r.arrears_outstanding),
        lps_charged: Number(r.lps_charged),
        lps_paid: Number(r.lps_paid),
        lps_out: Number(r.lps_outstanding),
        lps_waived: Number(r.lps_waived),
        lps_next: Number(r.lps_projected_next_voucher),
        unreleased: Number(r.unreleased_voucher_count),
        // "Never" rather than blank: never-paid is a different signal from
        // no-data, and it is the one a recovery call cares about most.
        last_payment: r.last_payment_date
          ? String(r.last_payment_date).slice(0, 10)
          : 'Never',
        days_since: r.days_since_last_payment == null ? '' : Number(r.days_since_last_payment),
        pay6: Number(r.payments_last_6m),
        pay12: Number(r.payments_last_12m),
      })),
      query.format,
    );
  }


  async listFilterOptions() {
    const segments = await this.prisma.segments.findMany({
      select: { id: true, code: true, name: true, display_order: true },
      orderBy: { display_order: 'asc' },
    });
    return { segments };
  }

  async createFeeHeadsSnapshot(
    dto: CreateFeeHeadsSnapshotDto,
    user: IJwtStaffPayload,
  ) {
    this.assertDateRange(dto);
    const view = dto.view ?? 'heads';
    const filters = this.buildSnapshotFilters(dto, view);
    const filtersHash = this.hashSnapshotFilters(filters);
    const { totals, reconciles } = await this.captureFeeHeadsTotals(dto, user);

    if (!reconciles) {
      throw new BadRequestException(
        'Cannot create a snapshot while totals do not reconcile. Review billed, to-be-billed, paid, and outstanding figures first.',
      );
    }

    const row = await this.prisma.financial_report_snapshots.create({
      data: {
        report_type: FinancialReportType.FEE_HEADS,
        from_date: this.parseDateOnlyUtc(dto.from_date),
        to_date: this.parseDateOnlyUtc(dto.to_date),
        view,
        filters,
        filters_hash: filtersHash,
        status: FinancialReportSnapshotStatus.DRAFT,
        totals,
        reconciles,
        generated_by: auditActorLabel(user),
        notes: dto.notes?.trim() || null,
      },
    });

    void this.auditLogs.log({
      entity_type: 'FINANCIAL_REPORT_SNAPSHOT',
      entity_id: String(row.id),
      action: 'CREATED',
      field: 'status',
      new_value: FinancialReportSnapshotStatus.DRAFT,
      changed_by: auditActorLabel(user),
      note: `Fee heads snapshot for ${dto.from_date} to ${dto.to_date}, view ${view}.`,
    });

    return this.mapSnapshotRow(row);
  }

  async listFeeHeadsSnapshots(
    query: ListFeeHeadsSnapshotsQueryDto,
    user: IJwtStaffPayload,
  ) {
    void user;
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: Prisma.financial_report_snapshotsWhereInput = {
      report_type: FinancialReportType.FEE_HEADS,
      ...(query.status && { status: query.status }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.financial_report_snapshots.findMany({
        where,
        orderBy: [{ generated_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.financial_report_snapshots.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.mapSnapshotRow(row)),
      pagination: createPaginationMeta(page, limit, total),
    };
  }

  async getFeeHeadsSnapshot(id: number, user: IJwtStaffPayload) {
    const row = await this.prisma.financial_report_snapshots.findFirst({
      where: {
        id,
        report_type: FinancialReportType.FEE_HEADS,
      },
    });
    if (!row) {
      throw new NotFoundException(`Fee heads snapshot ${id} not found`);
    }

    const liveCheck = await this.buildSnapshotLiveCheck(row, user);
    return {
      ...this.mapSnapshotRow(row),
      live_check: liveCheck,
    };
  }

  async finalizeFeeHeadsSnapshot(id: number, user: IJwtStaffPayload) {
    const row = await this.prisma.financial_report_snapshots.findFirst({
      where: {
        id,
        report_type: FinancialReportType.FEE_HEADS,
      },
    });
    if (!row) {
      throw new NotFoundException(`Fee heads snapshot ${id} not found`);
    }
    if (row.status === FinancialReportSnapshotStatus.FINALIZED) {
      throw new BadRequestException('This snapshot is already finalized.');
    }

    const liveCheck = await this.buildSnapshotLiveCheck(row, user);
    if (!liveCheck.reconciles) {
      throw new BadRequestException(
        'Cannot finalize: live totals do not reconcile. Resolve the mismatch in underlying fee heads first.',
      );
    }
    if (liveCheck.has_drift) {
      throw new BadRequestException(
        'Cannot finalize: live data has changed since this snapshot was created. Generate a fresh snapshot and review it again.',
      );
    }

    const duplicateFinalized =
      await this.prisma.financial_report_snapshots.findFirst({
        where: {
          report_type: row.report_type,
          from_date: row.from_date,
          to_date: row.to_date,
          view: row.view,
          filters_hash: row.filters_hash,
          status: FinancialReportSnapshotStatus.FINALIZED,
          NOT: { id: row.id },
        },
      });
    if (duplicateFinalized) {
      throw new BadRequestException(
        `A finalized snapshot already exists for this date range, view, and filters (snapshot #${duplicateFinalized.id}).`,
      );
    }

    const updated = await this.prisma.financial_report_snapshots.update({
      where: { id: row.id },
      data: {
        status: FinancialReportSnapshotStatus.FINALIZED,
        finalized_by: auditActorLabel(user),
        finalized_at: new Date(),
        totals: liveCheck.live_totals,
        reconciles: liveCheck.reconciles,
      },
    });

    void this.auditLogs.log({
      entity_type: 'FINANCIAL_REPORT_SNAPSHOT',
      entity_id: String(updated.id),
      action: 'FINALIZED',
      field: 'status',
      old_value: FinancialReportSnapshotStatus.DRAFT,
      new_value: FinancialReportSnapshotStatus.FINALIZED,
      changed_by: auditActorLabel(user),
      note: `Finalized fee heads snapshot for ${this.formatDateOnly(row.from_date)} to ${this.formatDateOnly(row.to_date)}, view ${row.view}.`,
    });

    return this.getFeeHeadsSnapshot(updated.id, user);
  }

  async deleteFeeHeadsSnapshot(id: number, user: IJwtStaffPayload) {
    const row = await this.prisma.financial_report_snapshots.findFirst({
      where: {
        id,
        report_type: FinancialReportType.FEE_HEADS,
      },
    });
    if (!row) {
      throw new NotFoundException(`Fee heads snapshot ${id} not found`);
    }
    if (row.status === FinancialReportSnapshotStatus.FINALIZED) {
      throw new BadRequestException('Finalized snapshots cannot be deleted.');
    }

    await this.prisma.financial_report_snapshots.delete({ where: { id: row.id } });

    void this.auditLogs.log({
      entity_type: 'FINANCIAL_REPORT_SNAPSHOT',
      entity_id: String(row.id),
      action: 'DELETED',
      changed_by: auditActorLabel(user),
      note: `Deleted draft fee heads snapshot for ${this.formatDateOnly(row.from_date)} to ${this.formatDateOnly(row.to_date)}.`,
    });

    return { id: row.id };
  }

  private buildSnapshotFilters(
    query: ListFeeHeadsQueryDto,
    view: string,
  ): Prisma.JsonObject {
    const sortNums = (values?: number[]) =>
      values?.length ? [...values].sort((a, b) => a - b) : undefined;
    const sortStrings = (values?: string[]) =>
      values?.length ? [...values].sort() : undefined;

    return {
      from_date: query.from_date,
      to_date: query.to_date,
      view,
      campus_id: sortNums(query.campus_id),
      class_id: sortNums(query.class_id),
      section_id: sortNums(query.section_id),
      segment_id: sortNums(query.segment_id),
      student_status: sortStrings(query.student_status),
      is_fee_endowment: query.is_fee_endowment ?? null,
      is_complementary: query.is_complementary ?? null,
      status: sortStrings(query.status),
    };
  }

  private hashSnapshotFilters(filters: Prisma.JsonObject): string {
    return createHash('sha256').update(JSON.stringify(filters)).digest('hex');
  }

  private async captureFeeHeadsTotals(
    query: ListFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ) {
    const leaf = this.feeHeadsLeafWhere(query);
    const studentWhere = this.buildStudentWhere(query, user);
    const where: Prisma.student_feesWhereInput = {
      ...leaf,
      students: studentWhere,
    };
    const [totals, studentCount] = await Promise.all([
      this.feeHeadMoneyTotals(where),
      this.prisma.students.count({
        where: { ...studentWhere, student_fees: { some: leaf } },
      }),
    ]);
    const check = this.buildTotalsCheck(totals);
    return {
      totals: {
        ...totals,
        student_count: studentCount,
        ...check,
      },
      reconciles: check.reconciles,
    };
  }

  private async buildSnapshotLiveCheck(
    row: {
      filters: Prisma.JsonValue;
      totals: Prisma.JsonValue;
      reconciles: boolean;
    },
    user: IJwtStaffPayload,
  ) {
    const filters = row.filters as unknown as ListFeeHeadsQueryDto;
    const { totals: liveTotals, reconciles } = await this.captureFeeHeadsTotals(
      filters,
      user,
    );
    const snapshotTotals = row.totals as Record<string, number | boolean>;
    const drift = this.diffSnapshotTotals(snapshotTotals, liveTotals);
    const hasDrift = Object.values(drift).some(
      (value) => typeof value === 'number' && Math.abs(value) > 0.009,
    );

    return {
      reconciles,
      has_drift: hasDrift,
      live_totals: liveTotals,
      drift,
      matches_snapshot: !hasDrift,
    };
  }

  private diffSnapshotTotals(
    snapshotTotals: Record<string, number | boolean>,
    liveTotals: Record<string, number | boolean>,
  ) {
    const keys = [
      'count',
      'student_count',
      'billed_count',
      'to_be_billed_count',
      'billed',
      'to_be_billed',
      'amount',
      'amount_paid',
      'outstanding',
    ] as const;

    const drift: Record<string, number> = {};
    for (const key of keys) {
      const snapshotValue = Number(snapshotTotals[key] ?? 0);
      const liveValue = Number(liveTotals[key] ?? 0);
      drift[key] = this.roundMoney(liveValue - snapshotValue);
    }
    return drift;
  }

  private mapSnapshotRow(row: {
    id: number;
    report_type: FinancialReportType;
    from_date: Date;
    to_date: Date;
    view: string;
    filters: Prisma.JsonValue;
    filters_hash: string;
    status: FinancialReportSnapshotStatus;
    totals: Prisma.JsonValue;
    reconciles: boolean;
    generated_by: string | null;
    generated_at: Date;
    finalized_by: string | null;
    finalized_at: Date | null;
    notes: string | null;
  }) {
    return {
      id: row.id,
      report_type: row.report_type,
      from_date: this.formatDateOnly(row.from_date),
      to_date: this.formatDateOnly(row.to_date),
      view: row.view,
      filters: row.filters,
      filters_hash: row.filters_hash,
      status: row.status,
      totals: row.totals,
      reconciles: row.reconciles,
      generated_by: row.generated_by,
      generated_at: row.generated_at.toISOString(),
      finalized_by: row.finalized_by,
      finalized_at: row.finalized_at?.toISOString() ?? null,
      notes: row.notes,
    };
  }

  /**
   * Takes the shared scope block rather than FinancialReportQueryDto so the
   * Defaulters report (which has no date range) reuses this one implementation
   * — including the applyStudentScope throw — instead of adding a third copy.
   */
  private buildStudentWhere(
    query: StudentScopeFilterQueryDto,
    user: IJwtStaffPayload,
  ): Prisma.studentsWhereInput {
    const includesGraduated = query.student_status?.includes(
      student_status.GRADUATED,
    );
    const graduationConditions = buildGraduationFilterWhere(
      query.graduated_from_class_id,
      query.graduated_year_range,
    );
    const studentWhere: Prisma.studentsWhereInput = {
      deleted_at: null,
      ...(query.campus_id?.length && { campus_id: { in: query.campus_id } }),
      ...(query.class_id?.length && {
        OR: includesGraduated
          ? [
              { class_id: { in: query.class_id } },
              { graduated_from_class_id: { in: query.class_id } },
            ]
          : [{ class_id: { in: query.class_id } }],
      }),
      ...(query.section_id?.length && { section_id: { in: query.section_id } }),
      ...(query.segment_id?.length && {
        classes: { segment_id: { in: query.segment_id } },
      }),
      ...(query.student_status?.length && { status: { in: query.student_status } }),
      ...(query.is_fee_endowment !== undefined && {
        is_fee_endowment: query.is_fee_endowment,
      }),
      ...(query.is_complementary !== undefined && {
        is_complementary: query.is_complementary,
      }),
      ...(graduationConditions.length && { AND: graduationConditions }),
    };
    return applyStudentScope(user, studentWhere, {
      campus_id: query.campus_id,
      class_id: query.class_id,
    });
  }

  /**
   * Same shape as buildStudentWhere plus a single-student (cc) filter for the
   * matrix's simple-search picker. Kept separate rather than widening
   * FinancialReportQueryDto because the matrix has no date range.
   */
  private buildMatrixStudentWhere(
    query: ListFeeMatrixQueryDto,
    user: IJwtStaffPayload,
  ): Prisma.studentsWhereInput {
    const includesGraduated = query.student_status?.includes(
      student_status.GRADUATED,
    );
    const graduationConditions = buildGraduationFilterWhere(
      query.graduated_from_class_id,
      query.graduated_year_range,
    );
    const studentWhere: Prisma.studentsWhereInput = {
      deleted_at: null,
      ...(query.cc != null && { cc: query.cc }),
      ...(query.campus_id?.length && { campus_id: { in: query.campus_id } }),
      ...(query.class_id?.length && {
        OR: includesGraduated
          ? [
              { class_id: { in: query.class_id } },
              { graduated_from_class_id: { in: query.class_id } },
            ]
          : [{ class_id: { in: query.class_id } }],
      }),
      ...(query.section_id?.length && { section_id: { in: query.section_id } }),
      ...(query.segment_id?.length && {
        classes: { segment_id: { in: query.segment_id } },
      }),
      ...(query.student_status?.length && { status: { in: query.student_status } }),
      ...(query.is_fee_endowment !== undefined && {
        is_fee_endowment: query.is_fee_endowment,
      }),
      ...(query.is_complementary !== undefined && {
        is_complementary: query.is_complementary,
      }),
      ...(graduationConditions.length && { AND: graduationConditions }),
    };
    return applyStudentScope(user, studentWhere, {
      campus_id: query.campus_id,
      class_id: query.class_id,
    });
  }

  /**
   * Excludes arrear (late payment) surcharges only — discount rows pass
   * through and are placed into the matrix as their own negative-amount
   * cells under their own target_month, same as any other head (see the
   * listFeeMatrix docstring above). academicYears is a superset — every
   * academic_year string that could plausibly contain a month in the
   * requested range under either term system — because SQL can't evaluate
   * the term-aware calendar-month resolution that narrows it precisely;
   * resolveHeadCalendarMonth does that narrowing in JS afterward.
   */
  private matrixLeafWhere(
    query: ListFeeMatrixQueryDto,
    academicYears: string[],
  ): Prisma.student_feesWhereInput {
    return {
      is_arrear_surcharge: false,
      academic_year: { in: academicYears },
      ...(query.status?.length && { status: { in: query.status } }),
    };
  }

  private assertMonthRange(query: { from_month: string; to_month: string }): void {
    if (query.from_month > query.to_month) {
      throw new BadRequestException('from_month must be on or before to_month');
    }
  }

  private parseYearMonth(value: string): { year: number; month: number } {
    const [year, month] = value.split('-').map(Number);
    return { year, month };
  }

  private matrixMonthKey(month: { year: number; month: number }): string {
    return `${month.year}-${month.month}`;
  }

  private formatColumnLabel(month: { year: number; month: number }): string {
    const MONTH_ABBR = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    return `${MONTH_ABBR[month.month - 1]} ${String(month.year).slice(-2)}`;
  }

  /** Every calendar month from `from` to `to` inclusive, capped at MATRIX_MAX_MONTHS. */
  private matrixMonthColumns(
    from: { year: number; month: number },
    to: { year: number; month: number },
  ): Array<{ year: number; month: number }> {
    const columns: Array<{ year: number; month: number }> = [];
    let year = from.year;
    let month = from.month;
    while (
      (year < to.year || (year === to.year && month <= to.month)) &&
      columns.length < MATRIX_MAX_MONTHS
    ) {
      columns.push({ year, month });
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return columns;
  }

  /**
   * Every academic_year string that could contain one of `months` under
   * either term system (4 = Apr-Mar, 8 = Aug-Jul) — see matrixLeafWhere.
   */
  private matrixCandidateAcademicYears(
    months: Array<{ year: number; month: number }>,
  ): string[] {
    const years = new Set<string>();
    for (const { year, month } of months) {
      for (const cutoff of [4, 8]) {
        const startYear = month >= cutoff ? year : year - 1;
        years.add(`${startYear}-${startYear + 1}`);
      }
    }
    return [...years];
  }

  /**
   * Resolves one head's target_month + academic_year to the real calendar
   * month it falls in, using the head's own term_start_month and falling
   * back to its student's class — same precedence as termOfHead everywhere
   * else in this file. Null when the academic_year string can't be parsed.
   */
  private resolveHeadCalendarMonth(
    head: {
      target_month: number;
      academic_year: string;
      term_start_month: number | null;
      students: {
        status?: student_status | null;
        class_id?: number | null;
        graduated_from_class_id?: number | null;
      };
    },
    classTerms: ReadonlyMap<number, number>,
  ): { year: number; month: number } | null {
    const classId = this.effectiveClassId(head.students);
    const term = termOfHead(head, { classId, classTerms });
    const year = calendarYearOf(head.target_month, head.academic_year, term);
    if (year == null) return null;
    return { year, month: head.target_month };
  }

  private matrixFeeTypeLabel(head: {
    description_prefix: string | null;
    fee_types: { description: string } | null;
    is_discount?: boolean;
    discount_presets?: { title: string } | null;
  }): string {
    if (head.is_discount) return head.discount_presets?.title ?? 'Discount';
    const feeName = head.fee_types?.description ?? '';
    return [head.description_prefix, feeName].filter(Boolean).join(' ') || '—';
  }

  private groupHeadsByStudent<T extends { student_id: number }>(
    heads: T[],
  ): Map<number, T[]> {
    const map = new Map<number, T[]>();
    for (const head of heads) {
      const list = map.get(head.student_id) ?? [];
      list.push(head);
      map.set(head.student_id, list);
    }
    return map;
  }

  /**
   * Mean/median/mode plus variance and standard deviation computed both ways
   * (population: divide by n — treats these values as the whole population;
   * sample: divide by n-1 — Bessel's correction, used when these values are
   * a sample standing in for a larger population). Mode is every value tied
   * for most frequent; empty when every value is unique (no mode).
   */
  private describeDistribution(rawValues: number[]): DistributionStats {
    const values = [...rawValues].sort((a, b) => a - b);
    const count = values.length;
    if (count === 0) {
      return {
        count: 0,
        sum: 0,
        min: 0,
        max: 0,
        mean: 0,
        median: 0,
        mode: [],
        variance_population: 0,
        variance_sample: 0,
        stddev_population: 0,
        stddev_sample: 0,
      };
    }

    const sum = this.roundMoney(values.reduce((a, b) => a + b, 0));
    const mean = this.roundMoney(sum / count);
    const mid = Math.floor(count / 2);
    const median = this.roundMoney(
      count % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2,
    );

    const frequency = new Map<number, number>();
    for (const v of values) frequency.set(v, (frequency.get(v) ?? 0) + 1);
    const maxFrequency = Math.max(...frequency.values());
    const mode =
      maxFrequency > 1
        ? [...frequency.entries()]
            .filter(([, freq]) => freq === maxFrequency)
            .map(([value]) => value)
            .sort((a, b) => a - b)
        : [];

    const sumSquaredDiffs = values.reduce((acc, v) => acc + (v - mean) ** 2, 0);
    const variancePopulation = this.roundMoney(sumSquaredDiffs / count);
    const varianceSample =
      count > 1 ? this.roundMoney(sumSquaredDiffs / (count - 1)) : 0;

    return {
      count,
      sum,
      min: values[0],
      max: values[count - 1],
      mean,
      median,
      mode,
      variance_population: variancePopulation,
      variance_sample: varianceSample,
      stddev_population: this.roundMoney(Math.sqrt(variancePopulation)),
      stddev_sample: this.roundMoney(Math.sqrt(varianceSample)),
    };
  }

  /**
   * Same distribution stats as describeDistribution, one set per fee_type_id.
   * Discount rows (fee_type_id: null) land in the shared "Unknown" bucket rather
   * than being broken out per discount preset — that finer detail is only
   * available in the flat "heads" view and the matrix's own cell labels.
   */
  private buildFeeTypeStatistics(
    heads: Array<{
      amount: Prisma.Decimal | number | null;
      fee_type_id: number | null;
      fee_types: { description: string } | null;
      is_discount: boolean;
    }>,
  ): FeeTypeStatistics[] {
    const groups = new Map<number, { label: string; values: number[] }>();
    for (const head of heads) {
      const key = head.fee_type_id ?? 0;
      const group = groups.get(key) ?? {
        label: head.is_discount ? 'Discount' : (head.fee_types?.description ?? 'Unknown'),
        values: [],
      };
      group.values.push(this.signedAmount(head));
      groups.set(key, group);
    }
    return [...groups.entries()]
      .map(([feeTypeId, group]) => ({
        fee_type_id: feeTypeId,
        fee_type: group.label,
        ...this.describeDistribution(group.values),
      }))
      .sort((a, b) => b.sum - a.sum);
  }

  private feeHeadsLeafWhere(
    query: ListFeeHeadsQueryDto,
  ): Prisma.student_feesWhereInput {
    return {
      is_arrear_surcharge: false,
      fee_date: {
        gte: this.parseDateOnlyUtc(query.from_date),
        lte: this.parseDateOnlyUtc(query.to_date),
      },
      ...(query.status?.length && { status: { in: query.status } }),
    };
  }

  private buildFeeHeadsWhere(
    query: ListFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Prisma.student_feesWhereInput {
    return {
      ...this.feeHeadsLeafWhere(query),
      students: this.buildStudentWhere(query, user),
    };
  }

  /**
   * Billed = already on a voucher (ISSUED / PARTIALLY_PAID / PAID / DISCOUNT).
   * To be billed = NOT_ISSUED (scheduled, no voucher yet).
   * Total = both. Paid / outstanding still cover the full filtered set.
   *
   * Discount rows (is_discount=true) store a POSITIVE amount — the sign flip to
   * negative is a convention every reader applies explicitly (see signedAmount;
   * VouchersService.normalizeVoucher and StudentFeesService.getMonthlyStatusForParent
   * do the same). Prisma's aggregate/groupBy can't conditionally negate in SQL, so
   * discounts are queried separately here and subtracted in JS. Discount rows are
   * always status=DISCOUNT (never NOT_ISSUED), so they always net out of "billed".
   */
  private async feeHeadMoneyTotals(where: Prisma.student_feesWhereInput) {
    const nonDiscountWhere: Prisma.student_feesWhereInput = { ...where, is_discount: false };
    const discountWhere: Prisma.student_feesWhereInput = { ...where, is_discount: true };

    const [totalsAgg, discAgg, byStatus, discByStatus] = await Promise.all([
      this.prisma.student_fees.aggregate({
        where: nonDiscountWhere,
        _sum: { amount: true, amount_paid: true },
        _count: true,
      }),
      this.prisma.student_fees.aggregate({
        where: discountWhere,
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.student_fees.groupBy({
        by: ['status'],
        where: nonDiscountWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.student_fees.groupBy({
        by: ['status'],
        where: discountWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

    let billed = 0;
    let billedCount = 0;
    let toBeBilled = 0;
    let toBeBilledCount = 0;
    for (const row of byStatus) {
      const amount = this.toMoney(row._sum.amount);
      const count = row._count._all;
      if ((row.status ?? fee_status_enum.NOT_ISSUED) === fee_status_enum.NOT_ISSUED) {
        toBeBilled = this.roundMoney(toBeBilled + amount);
        toBeBilledCount += count;
      } else {
        billed = this.roundMoney(billed + amount);
        billedCount += count;
      }
    }
    for (const row of discByStatus) {
      billed = this.roundMoney(billed - this.toMoney(row._sum.amount));
      billedCount += row._count._all;
    }

    const amount = this.roundMoney(
      this.toMoney(totalsAgg._sum.amount) - this.toMoney(discAgg._sum.amount),
    );
    const amountPaid = this.toMoney(totalsAgg._sum.amount_paid); // discount rows always have amount_paid=0
    return {
      count: totalsAgg._count + discAgg._count,
      billed_count: billedCount,
      to_be_billed_count: toBeBilledCount,
      billed,
      to_be_billed: toBeBilled,
      amount,
      amount_paid: amountPaid,
      outstanding: this.roundMoney(amount - amountPaid),
    };
  }

  private buildDepositsWhere(
    query: ListDepositsQueryDto,
    user: IJwtStaffPayload,
  ): Prisma.depositsWhereInput {
    return {
      deposit_date: {
        gte: this.parseLocalDayStart(query.from_date),
        lt: this.parseLocalDayAfter(query.to_date),
      },
      students: this.buildStudentWhere(query, user),
      ...(query.payment_method?.length && {
        payment_method: { in: query.payment_method },
      }),
      ...(query.bank_name?.length && { bank_name: { in: query.bank_name } }),
    };
  }

  /**
   * Discounts never touch deposit_allocations — a discount head's voucher_heads.balance
   * is hardcoded to 0 at creation and can never be deposited against (see
   * VouchersService.recordDeposit's allowedAmount clamp), so they're invisible to the
   * cash-vs-allocations reconciliation in buildDepositTotals. This is a separate,
   * non-cash total shown for cross-report context only — dated by each discount's own
   * fee_date within [from_date, to_date], a different date semantic than deposits'
   * deposit_date filter above. Never fold this into allocations_total/reconciles.
   */
  private async depositsDiscountTotal(
    query: ListDepositsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<{ amount: number; count: number }> {
    const studentWhere = this.buildStudentWhere(query, user);
    const agg = await this.prisma.student_fees.aggregate({
      where: {
        is_discount: true,
        fee_date: {
          gte: this.parseDateOnlyUtc(query.from_date),
          lte: this.parseDateOnlyUtc(query.to_date),
        },
        students: studentWhere,
      },
      _sum: { amount: true },
      _count: true,
    });
    // Positive magnitude — "amount discounted", not a signed netting figure like the
    // Fee Heads/Matrix reports use, since this is a standalone summary tile.
    return { amount: this.toMoney(agg._sum.amount), count: agg._count };
  }

  /**
   * Sibling to depositsDiscountTotal above, not a replacement — that one answers
   * "how much discount is scheduled in this period" (by fee_date, useful even for
   * discounts not yet realized against a paid voucher); this one answers "how much
   * discount was actually realized/applied to close a voucher in this period" (by
   * deposit_date, via the 'DISCOUNT' deposit_allocations VouchersService.recordDeposit
   * and MeezanService.handleBillPayment now write). Both are legitimate, different
   * questions — keep both tiles rather than picking one.
   */
  private async depositsAppliedDiscountTotal(
    query: ListDepositsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<{ amount: number; count: number }> {
    const agg = await this.prisma.deposit_allocations.aggregate({
      where: {
        type: 'DISCOUNT',
        deposits: this.buildDepositsWhere(query, user),
      },
      _sum: { amount: true },
      _count: true,
    });
    return { amount: this.toMoney(agg._sum.amount), count: agg._count };
  }

  private mapFeeHead(
    row: Prisma.student_feesGetPayload<{ select: typeof FEE_HEAD_SELECT }>,
    classTerms: ReadonlyMap<number, number>,
  ) {
    const amount = this.signedAmount(row);
    const amountPaid = this.toMoney(row.amount_paid); // always 0 for discount rows
    const classId =
      row.students.class_id ??
      row.students.graduated_from_class_id ??
      row.students.classes?.id ??
      row.students.graduated_from_class?.id ??
      null;
    const feeName = row.fee_types?.description ?? '';
    const feeType = row.is_discount
      ? (row.discount_presets?.title ?? 'Discount')
      : [row.description_prefix, feeName].filter(Boolean).join(' ');

    return {
      id: row.id,
      cc: row.students.cc,
      gr_number: row.students.gr_number,
      student_name: row.students.full_name,
      campus: row.students.campuses?.campus_name ?? '',
      class_name: this.resolveStudentClassName(row.students),
      section: row.students.sections?.description ?? '',
      fee_type: feeType || '—',
      period_label: getMonthYearLabel(
        row.target_month,
        row.academic_year,
        termOfHead(row, { classId, classTerms }),
      ),
      fee_date: this.formatDateOnly(row.fee_date),
      status: (row.status ?? fee_status_enum.NOT_ISSUED) as fee_status_enum,
      amount,
      amount_paid: amountPaid,
      outstanding: this.roundMoney(amount - amountPaid),
    };
  }

  private resolveStudentClassName(
    student:
      | {
          status?: student_status | null;
          classes?: { description: string } | null;
          graduated_from_class?: { description: string } | null;
        }
      | null
      | undefined,
  ): string {
    if (!student) return '';
    if (student.status === student_status.GRADUATED) {
      return student.graduated_from_class?.description ?? '';
    }
    return student.classes?.description ?? '';
  }

  private effectiveClassId(
    student:
      | {
          status?: student_status | null;
          class_id?: number | null;
          graduated_from_class_id?: number | null;
        }
      | null
      | undefined,
  ): number | null {
    if (!student) return null;
    if (student.status === student_status.GRADUATED) {
      return student.graduated_from_class_id ?? null;
    }
    return student.class_id ?? null;
  }

  private buildTotalsCheck(totals: {
    amount: number;
    amount_paid: number;
    outstanding: number;
    billed: number;
    to_be_billed: number;
  }) {
    const billedPlusToBeBilled = this.roundMoney(
      totals.billed + totals.to_be_billed,
    );
    const paidPlusOutstanding = this.roundMoney(
      totals.amount_paid + totals.outstanding,
    );
    return {
      billed_plus_to_be_billed: billedPlusToBeBilled === totals.amount,
      paid_plus_outstanding: paidPlusOutstanding === totals.amount,
      reconciles:
        billedPlusToBeBilled === totals.amount &&
        paidPlusOutstanding === totals.amount,
    };
  }

  private mapDeposit(
    row: Prisma.depositsGetPayload<{ select: typeof DEPOSIT_SELECT }>,
  ) {
    const byType = this.sumAllocations(row.deposit_allocations);
    return {
      id: row.id,
      deposit_date: this.formatDateTime(row.deposit_date),
      cc: row.students.cc,
      gr_number: row.students.gr_number,
      student_name: row.students.full_name,
      campus: row.students.campuses?.campus_name ?? '',
      class_name: row.students.classes?.description ?? '',
      section: row.students.sections?.description ?? '',
      payment_method: row.payment_method,
      bank_name: row.bank_name,
      reference_number: row.reference_number,
      total_amount: this.toMoney(row.total_amount),
      allocations: row.deposit_allocations.map((a) => ({
        type: a.type,
        amount: this.toMoney(a.amount),
      })),
      fee_heads: byType.FEE_HEAD,
      late_fee: byType.LATE_FEE,
      surcharge: byType.SURCHARGE,
      lps_total: this.roundMoney(byType.LATE_FEE + byType.SURCHARGE),
    };
  }

  private buildDepositTotals(
    cash: { _count: number; _sum: { total_amount: Prisma.Decimal | null } },
    byType: Array<{
      type: string;
      _sum: { amount: Prisma.Decimal | null };
    }>,
  ) {
    const feeHeads = this.typeSum(byType, 'FEE_HEAD');
    const lateFee = this.typeSum(byType, 'LATE_FEE');
    const surcharge = this.typeSum(byType, 'SURCHARGE');
    const allocationsTotal = this.roundMoney(feeHeads + lateFee + surcharge);
    const totalAmount = this.toMoney(cash._sum.total_amount);
    const cashDecimal = new Prisma.Decimal(cash._sum.total_amount ?? 0);
    // 'DISCOUNT' allocations are a non-cash credit (see
    // VouchersService.applyDiscountCreditInTx) — excluded here the same way
    // allocationsTotal above already only names FEE_HEAD/LATE_FEE/SURCHARGE,
    // otherwise a legitimately-applied discount would make this look like an
    // unreconciled cash discrepancy.
    const allocDecimal = byType
      .filter((row) => row.type !== 'DISCOUNT')
      .reduce((sum, row) => sum.plus(row._sum.amount ?? 0), new Prisma.Decimal(0));

    return {
      count: cash._count,
      total_amount: totalAmount,
      by_type: {
        FEE_HEAD: feeHeads,
        LATE_FEE: lateFee,
        SURCHARGE: surcharge,
      },
      lps_total: this.roundMoney(lateFee + surcharge),
      allocations_total: allocationsTotal,
      reconciles: cashDecimal.eq(allocDecimal),
    };
  }

  private typeSum(
    byType: Array<{ type: string; _sum: { amount: Prisma.Decimal | null } }>,
    type: AllocationType,
  ): number {
    const row = byType.find((r) => r.type === type);
    return this.toMoney(row?._sum.amount);
  }

  private sumAllocations(
    allocations: Array<{ type: string; amount: Prisma.Decimal }>,
  ): Record<AllocationType, number> {
    const sums: Record<AllocationType, number> = {
      FEE_HEAD: 0,
      LATE_FEE: 0,
      SURCHARGE: 0,
    };
    for (const row of allocations) {
      if (row.type === 'FEE_HEAD' || row.type === 'LATE_FEE' || row.type === 'SURCHARGE') {
        sums[row.type] = this.roundMoney(sums[row.type] + this.toMoney(row.amount));
      }
    }
    return sums;
  }

  private async loadClassTerms(): Promise<Map<number, number>> {
    const classes = await this.prisma.classes.findMany({
      select: { id: true, term_start_month: true },
    });
    return new Map(
      classes.map((c) => [c.id, c.term_start_month ?? 8]),
    );
  }

  private async buildExportFile(
    sheetName: string,
    basename: string,
    columns: ExportColumn[],
    rows: Record<string, string | number>[],
    format?: 'xlsx' | 'csv',
  ): Promise<ExportFile> {
    if (format === 'csv') {
      const lines = [
        columns.map((c) => this.csvCell(c.header)).join(','),
        ...rows.map((row) =>
          columns.map((c) => this.csvCell(row[c.key])).join(','),
        ),
      ];
      const buffer = Buffer.from(`\uFEFF${lines.join('\n')}`, 'utf8');
      return {
        buffer,
        filename: `${basename}.csv`,
        contentType: 'text/csv; charset=utf-8',
      };
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(sheetName);
    worksheet.columns = columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width,
    }));
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = HEADER_FILL;
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 25;
    for (const row of rows) {
      worksheet.addRow(row);
    }
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      filename: `${basename}.xlsx`,
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  private assertDateRange(query: FinancialReportQueryDto): void {
    if (query.from_date > query.to_date) {
      throw new BadRequestException('from_date must be on or before to_date');
    }
  }

  private assertExportCap(count: number): void {
    if (count > EXPORT_ROW_CAP) {
      throw new BadRequestException(
        `Export is limited to ${EXPORT_ROW_CAP.toLocaleString()} rows. Narrow the date range or add filters.`,
      );
    }
  }

  private parseDateOnlyUtc(value: string): Date {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }

  private parseLocalDayStart(value: string): Date {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  }

  private parseLocalDayAfter(value: string): Date {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  }

  private formatDateOnly(value: Date | null): string | null {
    if (!value) return null;
    return value.toISOString().slice(0, 10);
  }

  private formatDateTime(value: Date): string {
    return value.toISOString();
  }

  private toMoney(value: Prisma.Decimal | number | string | null | undefined): number {
    if (value == null) return 0;
    return this.roundMoney(Number(value));
  }

  /**
   * student_fees.amount is stored POSITIVE even for discount rows (is_discount=true;
   * StudentFeesService.createDiscount validates amount > 0) — the sign flip to negative
   * is a convention applied by every reader, never persisted. VouchersService.normalizeVoucher
   * and StudentFeesService.getMonthlyStatusForParent both do the same flip independently.
   * Anything here that sums or displays a discount's amount must go through this, or
   * totals will be overstated instead of netted.
   */
  private signedAmount(row: { amount: Prisma.Decimal | number | null; is_discount: boolean }): number {
    const raw = this.toMoney(row.amount);
    return row.is_discount ? -raw : raw;
  }

  private roundMoney(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private csvCell(value: string | number | undefined): string {
    const text = value == null ? '' : String(value);
    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }
}

type ExportColumn = { header: string; key: string; width: number };
