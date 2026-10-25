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
import { ScopeService } from '../../common/scope/scope.service';
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
import { formatPkPhone, normalizePkPhone } from '../../common/utils/phone.util';
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
  DefaulterGroupBy,
  ExportDepositsQueryDto,
  ExportFeeHeadsQueryDto,
  ExportFeeMatrixQueryDto,
  FinancialReportQueryDto,
  DefaulterColumnKey,
  ListDefaultersQueryDto,
  ListDepositsQueryDto,
  ListFeeHeadsQueryDto,
  ListFeeMatrixQueryDto,
  StudentScopeFilterQueryDto,
} from './dto/financial-report-query.dto';
import { DEFAULTER_COLUMN_KEYS } from './dto/financial-report-query.dto';
import type {
  CreateFeeHeadsSnapshotDto,
  ListFeeHeadsSnapshotsQueryDto,
} from './dto/financial-report-snapshot.dto';
import {
  DEFAULTER_SHEET_LIST_TITLE,
  campusLine,
  defaulterFilterLines,
  defaulterSheetHeading,
  type DefaulterFilterNames,
} from './defaulter-sheet-heading';
import {
  periodLine,
  writeSchoolSheets,
  type SchoolSheet,
  type SchoolSheetColumn,
  type SchoolSheetOptions,
} from './school-report-sheet';
import { defaulterWindowRemarks } from './defaulter-window-remark';
import type { SheetPaper } from './sheet-pdf';
import { fitSheetToText, headerText, schoolWorkbookFile, writeBanner, writeEmptySheet, writeTitleBlock } from './school-sheet-common';

const EXPORT_ROW_CAP = 25_000;
/** PDF exports of the school-format reports (TAFSD-306) stop here; Excel goes to EXPORT_ROW_CAP. */
const PDF_EXPORT_ROW_CAP = 2_000;
/** A full ISO instant ("2026-09-01T05:28:59.016Z") — printed as PKT on the school sheets. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
/** Safety valve on the matrix's statistics fetch — a filtered set larger than this is truncated, not failed. */
const STATS_ROW_CAP = 50_000;
/** Safety valve on the matrix's month-range width (3 years) — an absurdly wide range is capped, not failed. */
const MATRIX_MAX_MONTHS = 36;
const MONTH_ABBR_UPPER = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** classes.description -> the short LEVEL the school writes on its defaulter sheet. */
const DEFAULTER_LEVEL_ABBREVIATIONS: Record<string, string> = {
  'PRE NURSERY': 'PRE NUR',
  NURSERY: 'NUR',
  'K.G.': 'KG',
};
/** campus_code -> the short campus label in the CSV's Campus column (and the sheet's fallback campus line). */
const DEFAULTER_CAMPUS_LABELS: Record<string, string> = {
  GEJ: 'G-E-J',
  KNF: 'KNF',
  NNZ: 'NNN',
};
/** Fee Heads / Deposits export columns that get a TOTAL on the school-format sheet (TAFSD-268). */
const SCHOOL_SHEET_TOTAL_KEYS = new Set([
  'amount', 'amount_paid', 'waived', 'waived_amount', 'outstanding', 'billed', 'discount',
  'total_amount', 'fee_heads', 'late_fee', 'surcharge', 'lps_total',
  'head_count', 'student_count', 'discount_count',
]);
/** Of those, the counts (no thousands format). */
const SCHOOL_SHEET_COUNT_KEYS = new Set(['head_count', 'student_count', 'discount_count']);
/** What a student owes in one calendar month, and which fee heads it is made of. */
type DefaulterOwedMonth = {
  owed: number;
  partial: boolean;
  heads: Array<{ name: string; owed: number; partial: boolean }>;
};
/** One student row on a per-student month sheet: its fields, each month's cell and the row total. */
type StudentMonthRow = {
  item: Record<string, unknown>;
  months: Map<number, DefaulterOwedMonth>;
  total: number;
};
/** What a per-student month sheet (defaulters, fee date report) varies on; the layout is shared. */
type StudentMonthReportOptions = {
  query: {
    format?: string;
    columns?: DefaulterColumnKey[];
    group_by?: DefaulterGroupBy;
    breakdown_by_head?: boolean;
    campus_id?: number[];
    class_id?: number[];
    section_id?: number[];
    segment_id?: number[];
    graduated_from_class_id?: number[];
  };
  basename: string;
  generatedBy?: Pick<IJwtStaffPayload, 'sub' | 'username' | 'fullName'>;
  /** Drives DAY / DATE, and the session line unless sessionDate is given. */
  asOfDate: string;
  /** The date whose academic session heads the sheet; defaults to asOfDate. */
  sessionDate?: string;
  /** The banner under the school name. */
  listTitle: string;
  /** What to cut when the PDF is too wide even for A3 (TAFSD-425); defaults to the defaulters' options. */
  tooWideHint?: string;
  /** Month columns shown (month index year*12 + month-1); anything outside folds into EARLIER / LATER. */
  window: { lo: number; hi: number };
  /** The money columns, in order, each totalled. Shown when the picker has "amount". */
  amountColumns: Array<{ header: string; csvHeader: string; width: number; value: (r: StudentMonthRow) => number }>;
  remark: (r: StudentMonthRow) => string;
  /** A filter line to print larger, first; null when there isn't one. */
  leadLine: string | null;
  filterLines: (names: DefaulterFilterNames, omitClasses: boolean, groupLine: string[]) => string[];
  emptyMessage: string;
  emptySheetName: string;
};
/** One campus x class x fee date line of the By fee date export (TAFSD-341). */
/** One groupBy cell of the Fee Heads summary sheets (TAFSD-341). */
type FeeHeadCell = {
  student_id: number;
  campus: string;
  class_id: number | null;
  class_name: string;
  /** fee_date as year*12 + month (0-based), or null. */
  month: number | null;
  fee_type_id: number | null;
  description_prefix: string | null;
  /** The head's period (what By period rolls up by). */
  target_month: number;
  academic_year: string;
  term_start_month: number | null;
  is_discount: boolean;
  count: number;
  /** Signed: a discount is negative. */
  amount: number;
  /** Cash: a discount carries the negative of what it consumed. */
  amount_paid: number;
  waived: number;
};

type FeeDateClassRow = {
  campus: string;
  class_id: number | null;
  class_name: string;
  fee_date: string | null;
  head_count: number;
  discount_count: number;
  billed: number;
  discount: number;
  amount: number;
  amount_paid: number;
  waived: number;
  outstanding: number;
  /** Billed per fee head name (before discount). */
  heads: Map<string, number>;
};
/** students.status -> the STATUS column on the defaulters sheet. */
const DEFAULTER_STATUS_LABELS: Record<string, string> = {
  ENROLLED: 'Enrolled',
  LEFT: 'Left',
  EXPELLED: 'Expelled',
  GRADUATED: 'Graduated',
  SOFT_ADMISSION: 'Soft Admission',
  QUICK_ADMISSION: 'Quick Admission',
};
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
  waived_amount: true,
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
  campuses: { select: { campus_name: true, campus_code: true } },
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
  status: true,
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
    private readonly scope: ScopeService,
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
    if (view === 'fee_date') {
      return this.listFeeHeadsByFeeDate(query, user);
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
    const [students, discGroups, waivedGroups] = studentIds.length
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
            _sum: { amount: true, amount_paid: true },
            _count: { _all: true },
          }),
          // Waived amounts for this page's students — netted out of outstanding
          // and surfaced as a Waived column.
          this.prisma.student_fees.groupBy({
            by: ['student_id'],
            where: { ...where, is_discount: false, status: fee_status_enum.WAIVED, student_id: { in: studentIds } },
            _sum: { amount: true, amount_paid: true },
            _count: { _all: true },
          }),
        ])
      : [[], [], []];
    const studentMap = new Map(students.map((s) => [s.cc, s]));
    const discountByStudent = new Map(
      discGroups.map((d) => [
        d.student_id,
        { amount: this.toMoney(d._sum.amount), consumed: d._sum.amount_paid, count: d._count._all },
      ]),
    );
    const waivedByStudent = new Map(
      waivedGroups.map((w) => [w.student_id, this.waivedPortion(w._sum)]),
    );

    return {
      view: 'student' as const,
      items: groups.map((group) => {
        const student = studentMap.get(group.student_id);
        const discount = discountByStudent.get(group.student_id);
        const waived = this.roundMoney(waivedByStudent.get(group.student_id) ?? 0);
        const billed = this.roundMoney(this.toMoney(group._sum.amount) - (discount?.amount ?? 0));
        const paid = this.netPaid(group._sum.amount_paid, discount?.consumed);
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
          waived,
          outstanding: this.roundMoney(billed - paid - waived),
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
    const [groups, discGroups, waivedGroups, totals, studentCount, feeTypes] = await Promise.all([
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
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
      }),
      this.prisma.student_fees.groupBy({
        by: ['fee_type_id', 'description_prefix'],
        where: { ...where, is_discount: false, status: fee_status_enum.WAIVED },
        _sum: { amount: true, amount_paid: true },
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
      discGroups.map((d) => [
        groupKey(d),
        { amount: this.toMoney(d._sum.amount), consumed: d._sum.amount_paid, count: d._count._all },
      ]),
    );
    const waivedByKey = new Map(
      waivedGroups.map((w) => [groupKey(w), this.waivedPortion(w._sum)]),
    );
    const seenKeys = new Set(groups.map(groupKey));
    const items = groups.map((group) => {
      const discount = discountByKey.get(groupKey(group));
      const waived = this.roundMoney(waivedByKey.get(groupKey(group)) ?? 0);
      const amount = this.roundMoney(this.toMoney(group._sum.amount) - (discount?.amount ?? 0));
      const amountPaid = this.netPaid(group._sum.amount_paid, discount?.consumed);
      const feeName = group.fee_type_id != null ? feeTypeMap.get(group.fee_type_id) ?? '' : '';
      const feeType = [group.description_prefix, feeName].filter(Boolean).join(' ');
      return {
        fee_type_id: group.fee_type_id,
        fee_type: feeType || (group.fee_type_id == null ? 'Discount' : '—'),
        head_count: group._count._all + (discount?.count ?? 0),
        amount,
        amount_paid: amountPaid,
        waived,
        outstanding: this.roundMoney(amount - amountPaid - waived),
      };
    });
    // A discount bucket with no matching non-discount row (e.g. every fee head it
    // offsets fell outside this filter) still needs its own row so its amount isn't
    // silently dropped from the view.
    for (const disc of discGroups) {
      const key = groupKey(disc);
      if (seenKeys.has(key)) continue;
      const amount = -this.toMoney(disc._sum.amount);
      const amountPaid = this.netPaid(0, disc._sum.amount_paid);
      items.push({
        fee_type_id: disc.fee_type_id,
        fee_type: 'Discount',
        head_count: disc._count._all,
        amount,
        amount_paid: amountPaid,
        waived: 0,
        outstanding: this.roundMoney(amount - amountPaid),
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

    const [groups, discGroups, waivedGroups, totals, studentCount, classTerms] = await Promise.all([
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
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
      }),
      this.prisma.student_fees.groupBy({
        by: ['target_month', 'academic_year', 'term_start_month'],
        where: { ...where, is_discount: false, status: fee_status_enum.WAIVED },
        _sum: { amount: true, amount_paid: true },
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
      discGroups.map((d) => [
        periodKey(d),
        { amount: this.toMoney(d._sum.amount), consumed: d._sum.amount_paid, count: d._count._all },
      ]),
    );
    const waivedByPeriod = new Map(
      waivedGroups.map((w) => [periodKey(w), this.waivedPortion(w._sum)]),
    );
    const seenPeriodKeys = new Set(groups.map(periodKey));
    const buildPeriodItem = (
      targetMonth: number,
      academicYear: string,
      termStartMonth: number | null,
      amount: number,
      amountPaid: number,
      headCount: number,
      waived: number,
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
        waived,
        outstanding: this.roundMoney(amount - amountPaid - waived),
      };
    };
    const items = groups.map((group) => {
      const discount = discountByPeriod.get(periodKey(group));
      const waived = this.roundMoney(waivedByPeriod.get(periodKey(group)) ?? 0);
      const amount = this.roundMoney(this.toMoney(group._sum.amount) - (discount?.amount ?? 0));
      const amountPaid = this.netPaid(group._sum.amount_paid, discount?.consumed);
      return buildPeriodItem(
        group.target_month,
        group.academic_year,
        group.term_start_month,
        amount,
        amountPaid,
        group._count._all + (discount?.count ?? 0),
        waived,
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
          this.netPaid(0, disc._sum.amount_paid),
          disc._count._all,
          0,
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

    const [groups, discGroups, waivedGroups, totals, studentCount] = await Promise.all([
      this.prisma.student_fees.groupBy({
        by: ['student_id'],
        where: { ...where, is_discount: false },
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
      }),
      this.prisma.student_fees.groupBy({
        by: ['student_id'],
        where: { ...where, is_discount: true },
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
      }),
      this.prisma.student_fees.groupBy({
        by: ['student_id'],
        where: { ...where, is_discount: false, status: fee_status_enum.WAIVED },
        _sum: { amount: true, amount_paid: true },
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
    const perStudent = new Map<number, { amount: number; amountPaid: number; headCount: number; waived: number }>();
    for (const group of groups) {
      perStudent.set(group.student_id, {
        amount: this.toMoney(group._sum.amount),
        amountPaid: this.toMoney(group._sum.amount_paid),
        headCount: group._count._all,
        waived: 0,
      });
    }
    for (const disc of discGroups) {
      const existing = perStudent.get(disc.student_id) ?? { amount: 0, amountPaid: 0, headCount: 0, waived: 0 };
      existing.amount = this.roundMoney(existing.amount - this.toMoney(disc._sum.amount));
      existing.amountPaid = this.netPaid(existing.amountPaid, disc._sum.amount_paid);
      existing.headCount += disc._count._all;
      perStudent.set(disc.student_id, existing);
    }
    for (const w of waivedGroups) {
      const existing = perStudent.get(w.student_id) ?? { amount: 0, amountPaid: 0, headCount: 0, waived: 0 };
      existing.waived = this.roundMoney(existing.waived + this.waivedPortion(w._sum));
      perStudent.set(w.student_id, existing);
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
        waived: number;
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
        waived: 0,
        outstanding: 0,
      };
      existing.student_count += 1;
      existing.head_count += sums.headCount;
      existing.amount = this.roundMoney(existing.amount + sums.amount);
      existing.amount_paid = this.roundMoney(existing.amount_paid + sums.amountPaid);
      existing.waived = this.roundMoney(existing.waived + sums.waived);
      existing.outstanding = this.roundMoney(existing.amount - existing.amount_paid - existing.waived);
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

  /**
   * One row per fee_date, with the discount as its own column.
   *
   * A discount belongs to the fee date it was billed on — the voucher it rides
   * on — so grouping by fee_date keeps it next to the heads it reduces. The
   * other views can't: "By fee type" lumps every discount into one bucket, and
   * "By period" files it under whichever target month the discount row carries
   * (an annual voucher billed on one fee_date spreads over twelve months, with
   * its discount parked on one of them).
   *
   * billed = fee heads before discount; amount = billed + discount (net, what is
   * owed); amount_paid is cash only (netPaid). Waived heads stay in billed and
   * are netted out of outstanding, as in every other view.
   */
  private async listFeeHeadsByFeeDate(
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

    const [groups, discGroups, waivedGroups, totals, studentCount] = await Promise.all([
      this.prisma.student_fees.groupBy({
        by: ['fee_date'],
        where: { ...where, is_discount: false },
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
      }),
      this.prisma.student_fees.groupBy({
        by: ['fee_date'],
        where: { ...where, is_discount: true },
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
      }),
      this.prisma.student_fees.groupBy({
        by: ['fee_date'],
        where: { ...where, is_discount: false, status: fee_status_enum.WAIVED },
        _sum: { amount: true, amount_paid: true },
      }),
      this.feeHeadMoneyTotals(where),
      this.prisma.students.count({
        where: { ...studentWhere, student_fees: { some: leaf } },
      }),
    ]);

    type Bucket = {
      fee_date: string | null;
      head_count: number;
      discount_count: number;
      billed: number;
      discount: number;
      headsPaid: Prisma.Decimal | null;
      discountConsumed: Prisma.Decimal | null;
      waived: number;
    };
    // Union of all three group sets, so a fee date with only a discount (every
    // head it offsets fell outside the filter) still gets a row.
    const buckets = new Map<string, Bucket>();
    const bucketFor = (feeDate: Date | null) => {
      const key = this.formatDateOnly(feeDate) ?? '';
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          fee_date: this.formatDateOnly(feeDate),
          head_count: 0,
          discount_count: 0,
          billed: 0,
          discount: 0,
          headsPaid: null,
          discountConsumed: null,
          waived: 0,
        };
        buckets.set(key, bucket);
      }
      return bucket;
    };
    for (const g of groups) {
      const b = bucketFor(g.fee_date);
      b.head_count = g._count._all;
      b.billed = this.toMoney(g._sum.amount);
      b.headsPaid = g._sum.amount_paid;
    }
    for (const d of discGroups) {
      const b = bucketFor(d.fee_date);
      b.discount_count = d._count._all;
      b.discount = -this.toMoney(d._sum.amount);
      b.discountConsumed = d._sum.amount_paid;
    }
    for (const w of waivedGroups) {
      bucketFor(w.fee_date).waived = this.waivedPortion(w._sum);
    }

    const items = [...buckets.values()]
      // Oldest first; rows with no fee_date last.
      .sort((a, b) =>
        a.fee_date === b.fee_date ? 0
          : a.fee_date === null ? 1
            : b.fee_date === null ? -1
              : a.fee_date.localeCompare(b.fee_date),
      )
      .map((b) => {
        const amount = this.roundMoney(b.billed + b.discount);
        const amountPaid = this.netPaid(b.headsPaid, b.discountConsumed);
        return {
          fee_date: b.fee_date,
          head_count: b.head_count,
          discount_count: b.discount_count,
          billed: b.billed,
          discount: b.discount,
          amount,
          amount_paid: amountPaid,
          waived: b.waived,
          outstanding: this.roundMoney(amount - amountPaid - b.waived),
        };
      });
    const start = (page - 1) * limit;

    return {
      view: 'fee_date' as const,
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
    if (view === 'fee_date') {
      return this.exportFeeHeadsByFeeDate(query, user);
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
      { header: 'Waived', key: 'waived_amount', width: 14 },
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
      waived_amount: item.waived_amount,
      outstanding: item.outstanding,
    }));

    // TAFSD-341, in the defaulters format: one sheet per campus; within it the
    // classes in level order, each a heading, its heads (by section, student,
    // then fee date), a SUBTOTAL and a blank row. The CSV stays one flat list.
    // The defaulters student columns (C.C., G.R. #, LEVEL, STUDENT NAME,
    // STATUS), then the head's own.
    const sheetColumns: SchoolSheetColumn[] = [
      { header: 'C.C.', key: 'cc', width: 8 },
      { header: 'G.R. #', key: 'gr_number', width: 8 },
      { header: 'LEVEL', key: 'level', width: 11 },
      { header: 'STUDENT NAME', key: 'student_name', width: 30 },
      { header: 'STATUS', key: 'student_status', width: 11 },
      { header: 'FEE TYPE', key: 'fee_type', width: 24 },
      { header: 'PERIOD', key: 'period_label', width: 11 },
      { header: 'FEE DATE', key: 'fee_date', width: 12 },
      { header: 'HEAD STATUS', key: 'status', width: 13 },
      { header: 'AMOUNT', key: 'amount', width: 13, total: true, money: true },
      { header: 'PAID', key: 'amount_paid', width: 13, total: true, money: true },
      { header: 'WAIVED', key: 'waived_amount', width: 12, total: true, money: true },
      { header: 'OUTSTANDING', key: 'outstanding', width: 14, total: true, money: true },
    ];
    const placed = rows.map((row, i) => ({
      classId: this.effectiveClassId(row.students),
      data: {
        ...data[i],
        gr_number: this.defaulterGr(data[i].gr_number),
        level: this.defaulterLevel(data[i].class_name, data[i].section),
        student_name: String(data[i].student_name ?? '').toUpperCase(),
        student_status: DEFAULTER_STATUS_LABELS[String(row.students.status ?? '')] ?? '',
        status: data[i].status ? String(data[i].status).replace(/_/g, ' ') : '',
      } as Record<string, string | number>,
    }));
    const tabs = await this.campusTabs();
    const byCampus = new Map<string, typeof placed>();
    for (const p of placed) {
      const campus = String(p.data.campus ?? '').trim() || 'Unassigned';
      if (!byCampus.has(campus)) byCampus.set(campus, []);
      byCampus.get(campus)!.push(p);
    }
    const sheets: SchoolSheet[] = [...byCampus.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([campus, campusRows]) => {
        // Class in level order (classes.id runs in level order, no class last),
        // then section, name, C.C. and fee date (none last); stable on id.
        const sorted = [...campusRows].sort(
          (a, b) =>
            (a.classId ?? Number.MAX_SAFE_INTEGER) - (b.classId ?? Number.MAX_SAFE_INTEGER) ||
            String(a.data.section).localeCompare(String(b.data.section)) ||
            String(a.data.student_name).localeCompare(String(b.data.student_name)) ||
            Number(a.data.cc) - Number(b.data.cc) ||
            (a.data.fee_date === b.data.fee_date
              ? 0
              : !a.data.fee_date
                ? 1
                : !b.data.fee_date
                  ? -1
                  : String(a.data.fee_date).localeCompare(String(b.data.fee_date))),
        );
        const groups = new Map<string, { label: string; rows: Array<Record<string, string | number>> }>();
        for (const p of sorted) {
          const key = `${p.classId ?? 'none'}`;
          if (!groups.has(key)) {
            const name = String(p.data.class_name ?? '').trim();
            groups.set(key, { label: p.classId == null || !name ? 'NO CLASS' : `CLASS ${name}`.toUpperCase(), rows: [] });
          }
          groups.get(key)!.rows.push(p.data);
        }
        const groupList = [...groups.values()];
        return {
          tab: tabs.get(campus) ?? campus,
          campus: campusLine(campus),
          columns: sheetColumns,
          groups: groupList,
          rows: groupList.flatMap((g) => g.rows),
          rowNoun: ['FEE HEAD', 'FEE HEADS'] as [string, string],
          defaulterNumbers: true,
        };
      });

    return this.buildSchoolExportFile(
      'Fee Heads',
      'FEE HEADS REPORT',
      `fee-heads-report-${query.from_date}-to-${query.to_date}`,
      columns,
      data,
      query,
      this.feeHeadsFilterWords(query),
      user,
      sheets,
    );
  }

  private async exportFeeHeadsByStudent(
    query: ExportFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    // TAFSD-341: the defaulters student sheet; TAFSD-425: its PDF is that sheet printed.
    return this.exportFeeHeadsByStudentSheet(query, user);
  }

  /**
   * By student in the defaulters format (TAFSD-341): the defaulters student
   * sheet — campus sheets, the fixed student columns, optional class / section
   * / family groups with SUBTOTALs, the column picker — with one column per
   * fee-date month in the range holding what was billed that month (net of
   * discount; with breakdown_by_head, one sub-column per fee head and a
   * DISCOUNT column), then AMOUNT, PAID, WAIVED and OUTSTANDING. Same money
   * rules as listFeeHeadsByStudent, so the sheet totals equal the screen's.
   */
  private async exportFeeHeadsByStudentSheet(
    query: ExportFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    const leaf = this.feeHeadsLeafWhere(query);
    const studentWhere = this.buildStudentWhere(query, user);
    const students = await this.prisma.students.findMany({
      where: { ...studentWhere, student_fees: { some: leaf } },
      select: {
        cc: true,
        gr_number: true,
        full_name: true,
        status: true,
        class_id: true,
        graduated_from_class_id: true,
        campuses: { select: { campus_name: true, campus_code: true } },
        classes: { select: { description: true } },
        graduated_from_class: { select: { description: true } },
        sections: { select: { description: true } },
      },
      take: EXPORT_ROW_CAP + 1,
    });
    this.assertExportCap(students.length);
    if (query.format === 'pdf' && students.length > PDF_EXPORT_ROW_CAP) {
      throw new BadRequestException(
        `PDF export is limited to ${PDF_EXPORT_ROW_CAP.toLocaleString()} students (this has ${students.length.toLocaleString()}). Narrow the filters or export Excel.`,
      );
    }
    const [groups, feeTypes] = await Promise.all([
      this.prisma.student_fees.groupBy({
        by: ['student_id', 'fee_date', 'fee_type_id', 'is_discount', 'status'],
        where: { ...leaf, students: studentWhere },
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
      }),
      this.prisma.fee_types.findMany({ select: { id: true, description: true, priority_order: true } }),
    ]);
    const feeTypeName = new Map(feeTypes.map((ft) => [ft.id, ft.description.trim() || 'OTHER']));
    const rank = new Map(
      [...feeTypes]
        .sort((a, b) => (a.priority_order ?? 1e9) - (b.priority_order ?? 1e9) || a.id - b.id)
        .map((ft, i) => [ft.description.trim() || 'OTHER', i]),
    );
    const DISCOUNT_HEAD = 'DISCOUNT';
    const headRank = (name: string) => (name === DISCOUNT_HEAD ? Number.MAX_SAFE_INTEGER : rank.get(name) ?? 1e9);

    type Money = {
      billed: number;
      discount: number;
      headsPaid: number;
      discountConsumed: number;
      waived: number;
      /** month index -> head name -> net billed */
      months: Map<number, Map<string, number>>;
    };
    const money = new Map<number, Money>();
    for (const g of groups) {
      let m = money.get(g.student_id);
      if (!m) {
        m = { billed: 0, discount: 0, headsPaid: 0, discountConsumed: 0, waived: 0, months: new Map() };
        money.set(g.student_id, m);
      }
      const amount = this.toMoney(g._sum.amount);
      const paid = this.toMoney(g._sum.amount_paid);
      let head: string;
      // Discount rows store a positive amount that reduces the bill (the rollup
      // shows it negated), so it enters the month as a negative.
      let signed = amount;
      if (g.is_discount) {
        m.discount = this.roundMoney(m.discount - amount);
        m.discountConsumed += paid;
        head = DISCOUNT_HEAD;
        signed = -amount;
      } else {
        m.billed = this.roundMoney(m.billed + amount);
        m.headsPaid += paid;
        if (g.status === fee_status_enum.WAIVED) m.waived = this.roundMoney(m.waived + this.waivedPortion(g._sum));
        head = g.fee_type_id == null ? 'OTHER' : feeTypeName.get(g.fee_type_id) ?? 'OTHER';
      }
      const idx = g.fee_date ? g.fee_date.getUTCFullYear() * 12 + g.fee_date.getUTCMonth() : -1;
      const month = m.months.get(idx) ?? new Map<string, number>();
      month.set(head, this.roundMoney((month.get(head) ?? 0) + signed));
      m.months.set(idx, month);
    }

    const rows: StudentMonthRow[] = students
      .map((st) => {
        const m = money.get(st.cc);
        const amount = this.roundMoney((m?.billed ?? 0) + (m?.discount ?? 0));
        const paid = this.netPaid(m?.headsPaid ?? 0, m?.discountConsumed ?? 0);
        const waived = m?.waived ?? 0;
        const months = new Map<number, DefaulterOwedMonth>();
        for (const [idx, heads] of m?.months ?? []) {
          const names = [...heads.keys()].sort((a, b) => headRank(a) - headRank(b) || a.localeCompare(b));
          months.set(idx, {
            owed: this.roundMoney([...heads.values()].reduce((sum, v) => sum + v, 0)),
            partial: false,
            heads: names.map((name) => ({ name, owed: heads.get(name)!, partial: false })),
          });
        }
        return {
          item: {
            cc: st.cc,
            gr_number: st.gr_number ?? '',
            student_name: st.full_name ?? '',
            campus: st.campuses?.campus_name ?? '',
            campus_code: st.campuses?.campus_code ?? '',
            class_id: st.status === student_status.GRADUATED ? st.graduated_from_class_id : st.class_id,
            class_name: this.resolveStudentClassName(st),
            section: st.sections?.description ?? '',
            student_status: st.status,
            amount_paid: paid,
            waived,
            outstanding: this.roundMoney(amount - paid - waived),
          },
          months,
          total: amount,
        };
      })
      // As on the paper sheet: class in level order, then section, then name.
      .sort(
        (a, b) =>
          (Number(a.item.class_id ?? Number.MAX_SAFE_INTEGER) - Number(b.item.class_id ?? Number.MAX_SAFE_INTEGER)) ||
          String(a.item.section).localeCompare(String(b.item.section)) ||
          String(a.item.student_name).localeCompare(String(b.item.student_name)),
      );

    const toIdx = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
    const hi = toIdx(query.to_date);
    const lo = Math.max(toIdx(query.from_date), hi - 23);
    const period = periodLine(query.from_date, query.to_date);
    const remark = (r: StudentMonthRow) => {
      const outstanding = Number(r.item.outstanding);
      const paid = Number(r.item.amount_paid);
      if (outstanding <= 0) return paid <= 0 && Number(r.item.waived) > 0 ? 'Waived' : 'Paid';
      return paid > 0 ? 'Part-paid' : 'Unpaid';
    };
    return this.buildStudentMonthReport(rows, {
      query,
      basename: `fee-heads-by-student-${query.from_date}-to-${query.to_date}`,
      generatedBy: user,
      asOfDate: this.todayPkt(),
      sessionDate: query.to_date,
      listTitle: 'FEE HEADS REPORT — BY STUDENT',
      tooWideHint: 'Shorten the date range, turn off the fee head breakdown, or untick some columns.',
      window: { lo, hi },
      amountColumns: [
        { header: 'AMOUNT', csvHeader: 'Amount', width: 14, value: (r) => r.total },
        { header: 'PAID', csvHeader: 'Amount paid', width: 14, value: (r) => Number(r.item.amount_paid) },
        { header: 'WAIVED', csvHeader: 'Waived', width: 12, value: (r) => Number(r.item.waived) },
        { header: 'OUTSTANDING', csvHeader: 'Outstanding', width: 15, value: (r) => Number(r.item.outstanding) },
      ],
      remark,
      leadLine: period,
      filterLines: (names, omitClasses, groupLine) =>
        defaulterFilterLines(query, names, period, omitClasses, [], [...this.feeHeadsFilterWords(query), ...groupLine]),
      emptyMessage: 'Nothing matches the current filters.',
      emptySheetName: 'Fee Heads by Student',
    });
  }

  /**
   * By fee type in the defaulters format (TAFSD-341): one sheet per campus,
   * one row per fee type (fee types' priority order, discount last) with how
   * many heads and students, one column per fee-date month of what was billed
   * net of discount, then AMOUNT / PAID / WAIVED / OUTSTANDING and a TOTAL.
   * Discounts net into the fee type they share a key with, as on the screen.
   */
  private async exportFeeHeadsByFeeType(
    query: ExportFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    const { cells, rank, feeTypeName } = await this.loadFeeHeadCells(query, user);
    const typeKey = (c: FeeHeadCell) => `${c.fee_type_id ?? ''}|${c.description_prefix ?? ''}`;
    const nonDiscountKeys = new Set(cells.filter((c) => !c.is_discount).map((c) => `${c.campus}|${typeKey(c)}`));
    return this.writeFeeHeadSummary(query, user, cells, {
      sheetName: 'Fee Heads by Type',
      reportTitle: 'FEE HEADS REPORT — BY FEE TYPE',
      basename: `fee-heads-by-type-${query.from_date}-to-${query.to_date}`,
      label: { header: 'FEE TYPE', width: 30 },
      rowNoun: ['FEE TYPE', 'FEE TYPES'],
      // A student holds several fee types: their count doesn't add up.
      studentsTotal: false,
      keyOf: (c) => {
        // A discount with no head of its own key this filter gets its own row.
        if (c.is_discount && !nonDiscountKeys.has(`${c.campus}|${typeKey(c)}`)) return { key: 'discount', label: 'DISCOUNT', order: [1, 0, ''] };
        const name = c.fee_type_id != null ? feeTypeName.get(c.fee_type_id) ?? '' : '';
        const label = [c.description_prefix, name].filter(Boolean).join(' ') || (c.fee_type_id == null ? 'Discount' : '—');
        return { key: typeKey(c), label: label.toUpperCase(), order: [0, rank.get(name) ?? 1e9, label] };
      },
    });
  }

  /**
   * By period in the defaulters format (TAFSD-341): one sheet per campus, one
   * row per period (the head's target month) in calendar order, one column per
   * fee-date month of what was billed net of discount, then AMOUNT / PAID /
   * WAIVED / OUTSTANDING and a TOTAL. A discount nets into its own period, and
   * a period holding only discounts still gets a row, as on the screen.
   */
  private async exportFeeHeadsByPeriod(
    query: ExportFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    const [{ cells }, classTerms] = await Promise.all([this.loadFeeHeadCells(query, user), this.loadClassTerms()]);
    const defaultTerm = classTerms.size ? [...classTerms.values()][0] : 8;
    return this.writeFeeHeadSummary(query, user, cells, {
      sheetName: 'Fee Heads by Period',
      reportTitle: 'FEE HEADS REPORT — BY PERIOD',
      basename: `fee-heads-by-period-${query.from_date}-to-${query.to_date}`,
      label: { header: 'PERIOD', width: 12 },
      rowNoun: ['PERIOD', 'PERIODS'],
      // A student is billed for several periods: their count doesn't add up.
      studentsTotal: false,
      keyOf: (c) => {
        const term = { termStartMonth: c.term_start_month ?? defaultTerm };
        const idx = monthAbsoluteIndex(c.target_month, c.academic_year, term);
        return {
          key: `${c.target_month}|${c.academic_year}|${c.term_start_month ?? ''}`,
          label: getMonthYearLabel(c.target_month, c.academic_year, term).toUpperCase(),
          order: [idx == null ? 1 : 0, idx ?? 0, c.academic_year],
        };
      },
    });
  }

  /**
   * By class in the defaulters format (TAFSD-341): one sheet per campus, one
   * row per class in level order with its students and heads, one column per
   * fee-date month of what was billed net of discount, then AMOUNT / PAID /
   * WAIVED / OUTSTANDING and a TOTAL. Class is the student's effective class
   * (graduated → the class they left), as on the screen.
   */
  private async exportFeeHeadsByClass(
    query: ExportFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    const { cells } = await this.loadFeeHeadCells(query, user);
    return this.writeFeeHeadSummary(query, user, cells, {
      sheetName: 'Fee Heads by Class',
      reportTitle: 'FEE HEADS REPORT — BY CLASS',
      basename: `fee-heads-by-class-${query.from_date}-to-${query.to_date}`,
      label: { header: 'CLASS', width: 20 },
      rowNoun: ['CLASS', 'CLASSES'],
      keyOf: (c) => ({
        key: String(c.class_id ?? 'none'),
        label: (c.class_name || 'Unassigned').toUpperCase(),
        order: [c.class_id == null ? 1 : 0, c.class_id ?? 0, ''],
      }),
    });
  }

  /**
   * One row per (student, fee date, fee type, prefix, discount, status) — the
   * grain every Fee Heads summary sheet rolls up from (TAFSD-341). Money as in
   * mapFeeHead: a discount's amount negative and its paid the negative of what
   * it consumed (so paid sums to netPaid), waived the waivedPortion.
   */
  private async loadFeeHeadCells(query: ListFeeHeadsQueryDto, user: IJwtStaffPayload) {
    const leaf = this.feeHeadsLeafWhere(query);
    const studentWhere = this.buildStudentWhere(query, user);
    const [students, groups, feeTypes] = await Promise.all([
      this.prisma.students.findMany({
        where: { ...studentWhere, student_fees: { some: leaf } },
        select: {
          cc: true,
          status: true,
          class_id: true,
          graduated_from_class_id: true,
          classes: { select: { description: true } },
          graduated_from_class: { select: { description: true } },
          campuses: { select: { campus_name: true } },
        },
      }),
      this.prisma.student_fees.groupBy({
        by: [
          'student_id', 'fee_date', 'fee_type_id', 'description_prefix', 'is_discount', 'status',
          'target_month', 'academic_year', 'term_start_month',
        ],
        where: { ...leaf, students: studentWhere },
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
      }),
      this.prisma.fee_types.findMany({ select: { id: true, description: true, priority_order: true } }),
    ]);
    const studentOf = new Map(students.map((st) => [st.cc, st]));
    const feeTypeName = new Map(feeTypes.map((ft) => [ft.id, ft.description ?? '']));
    const rank = new Map(
      [...feeTypes]
        .sort((a, b) => (a.priority_order ?? 1e9) - (b.priority_order ?? 1e9) || a.id - b.id)
        .map((ft, i) => [ft.description ?? '', i]),
    );
    const cells: FeeHeadCell[] = groups.map((g) => {
      const st = studentOf.get(g.student_id);
      const amount = this.toMoney(g._sum.amount);
      const paid = this.toMoney(g._sum.amount_paid);
      const date = g.fee_date ? new Date(g.fee_date) : null;
      return {
        student_id: g.student_id,
        campus: st?.campuses?.campus_name?.trim() || 'Unassigned',
        class_id: this.effectiveClassId(st),
        class_name: this.resolveStudentClassName(st),
        month: date ? date.getUTCFullYear() * 12 + date.getUTCMonth() : null,
        fee_type_id: g.fee_type_id,
        description_prefix: g.description_prefix,
        target_month: g.target_month,
        academic_year: g.academic_year,
        term_start_month: g.term_start_month,
        is_discount: g.is_discount,
        count: g._count._all,
        amount: g.is_discount ? -amount : amount,
        amount_paid: g.is_discount ? this.netPaid(0, g._sum.amount_paid) : paid,
        waived: !g.is_discount && g.status === fee_status_enum.WAIVED ? this.waivedPortion(g._sum) : 0,
      };
    });
    return { cells, rank, feeTypeName };
  }

  /**
   * The Fee Heads summary sheet (TAFSD-341): rows keyed by `keyOf`, one sheet
   * per campus with the defaulters title block, tab and numbers; the month
   * columns run from from_date's month to to_date's ("EARLIER" / "LATER" /
   * "NO FEE DATE" only when a head falls outside). The CSV is the same table,
   * flat, with a Campus column.
   */
  private async writeFeeHeadSummary(
    query: ExportFeeHeadsQueryDto,
    user: IJwtStaffPayload,
    cells: FeeHeadCell[],
    opts: {
      sheetName: string;
      reportTitle: string;
      basename: string;
      label: { header: string; width: number };
      rowNoun: [string, string];
      /** Sum STUDENTS into the TOTAL — only when each student is in one row. */
      studentsTotal?: boolean;
      keyOf: (c: FeeHeadCell) => { key: string; label: string; order: [number, number, string] };
    },
  ): Promise<ExportFile> {
    const monthIdx = (iso: string) => {
      const [y, m] = iso.split('-').map(Number);
      return y * 12 + (m - 1);
    };
    const lo = monthIdx(query.from_date);
    const hi = monthIdx(query.to_date);
    const span = hi - lo + 1;
    const monthKey = (c: FeeHeadCell) =>
      c.month == null ? 'month:none' : c.month < lo ? 'month:earlier' : c.month > hi ? 'month:later' : `month:${c.month}`;
    const monthColumns: SchoolSheetColumn[] = [];
    const used = new Set(cells.map(monthKey));
    if (used.has('month:earlier')) monthColumns.push({ header: 'EARLIER', key: 'month:earlier', width: 11, total: true, money: true });
    for (let idx = lo; idx <= hi; idx++) {
      const name = MONTH_ABBR_UPPER[idx % 12];
      monthColumns.push({
        header: span > 12 ? `${name} ${String(Math.floor(idx / 12)).slice(-2)}` : name,
        key: `month:${idx}`,
        width: 11,
        total: true,
        money: true,
      });
    }
    if (used.has('month:later')) monthColumns.push({ header: 'LATER', key: 'month:later', width: 11, total: true, money: true });
    if (used.has('month:none')) monthColumns.push({ header: 'NO FEE DATE', key: 'month:none', width: 11, total: true, money: true });

    type Row = { campus: string; key: string; label: string; order: [number, number, string]; students: Set<number>; data: Record<string, string | number> };
    const acc = new Map<string, Row>();
    for (const c of cells) {
      const k = opts.keyOf(c);
      const id = `${c.campus}|${k.key}`;
      let row = acc.get(id);
      if (!row) {
        row = { campus: c.campus, key: k.key, label: k.label, order: k.order, students: new Set(), data: { amount: 0, amount_paid: 0, waived: 0, head_count: 0 } };
        acc.set(id, row);
      }
      row.students.add(c.student_id);
      const d = row.data;
      const mk = monthKey(c);
      d[mk] = this.roundMoney(Number(d[mk] ?? 0) + c.amount);
      d.head_count = Number(d.head_count) + c.count;
      d.amount = this.roundMoney(Number(d.amount) + c.amount);
      d.amount_paid = this.roundMoney(Number(d.amount_paid) + c.amount_paid);
      d.waived = this.roundMoney(Number(d.waived) + c.waived);
    }
    const rows = [...acc.values()].sort(
      (a, b) =>
        a.campus.localeCompare(b.campus) ||
        a.order[0] - b.order[0] ||
        a.order[1] - b.order[1] ||
        a.order[2].localeCompare(b.order[2]),
    );
    for (const r of rows) {
      r.data.label = r.label;
      r.data.campus = r.campus;
      r.data.student_count = r.students.size;
      r.data.outstanding = this.roundMoney(Number(r.data.amount) - Number(r.data.amount_paid) - Number(r.data.waived));
      for (const col of monthColumns) if (r.data[col.key] === undefined) r.data[col.key] = 0;
    }

    const lead: SchoolSheetColumn[] = [
      { header: opts.label.header, key: 'label', width: opts.label.width },
      { header: 'STUDENTS', key: 'student_count', width: 10, total: opts.studentsTotal !== false },
      { header: 'HEADS', key: 'head_count', width: 9, total: true },
    ];
    const tail: SchoolSheetColumn[] = [
      { header: 'AMOUNT', key: 'amount', width: 14, total: true, money: true },
      { header: 'PAID', key: 'amount_paid', width: 14, total: true, money: true },
      { header: 'WAIVED', key: 'waived', width: 12, total: true, money: true },
      { header: 'OUTSTANDING', key: 'outstanding', width: 14, total: true, money: true },
    ];
    const sheetColumns = [...lead, ...monthColumns, ...tail];
    const tabs = await this.campusTabs();
    const byCampus = new Map<string, Array<Record<string, string | number>>>();
    for (const r of rows) {
      if (!byCampus.has(r.campus)) byCampus.set(r.campus, []);
      byCampus.get(r.campus)!.push(r.data);
    }
    const sheets: SchoolSheet[] = [...byCampus.entries()].map(([campus, campusRows]) => ({
      tab: tabs.get(campus) ?? campus,
      campus: campusLine(campus),
      columns: sheetColumns,
      rows: campusRows,
      rowNoun: opts.rowNoun,
      defaulterNumbers: true,
    }));
    const columns: ExportColumn[] = [
      { header: 'Campus', key: 'campus', width: 24 },
      ...sheetColumns.map((c) => ({ header: c.header, key: c.key, width: c.width })),
    ];
    return this.buildSchoolExportFile(
      opts.sheetName,
      opts.reportTitle,
      opts.basename,
      columns,
      rows.map((r) => r.data),
      query,
      this.feeHeadsFilterWords(query),
      user,
      sheets,
    );
  }

  private async exportFeeHeadsByFeeDate(
    query: ExportFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    const all = { ...query, page: 1, limit: EXPORT_ROW_CAP + 1 };
    const result = await this.listFeeHeadsByFeeDate(all, user);
    this.assertExportCap(result.items.length);
    const { rows, heads } = await this.loadFeeDateClassRows(query, user);

    // TAFSD-341, in the defaulters format: one sheet per campus; within it the
    // classes in level order, each a heading, its fee dates, a SUBTOTAL and a
    // blank row; billed split into one column per fee head under BILLED.
    const headKey = (name: string) => `head:${name}`;
    const headColumns = (names: string[]): SchoolSheetColumn[] => [
      // TAFSD-425: 10 holds "1,698,429" and keeps a busy fee date sheet printable on A3.
      ...names.map((name) => ({ header: name, key: headKey(name), width: 10, group: 'Billed', total: true, money: true })),
      { header: 'Total', key: 'billed', width: 12, group: 'Billed', total: true, money: true },
    ];
    const tail: SchoolSheetColumn[] = [
      { header: 'Discounts', key: 'discount_count', width: 11, total: true },
      { header: 'Discount', key: 'discount', width: 13, total: true, money: true },
      { header: 'Net amount', key: 'amount', width: 14, total: true, money: true },
      { header: 'Amount paid', key: 'amount_paid', width: 14, total: true, money: true },
      { header: 'Waived', key: 'waived', width: 12, total: true, money: true },
      { header: 'Outstanding', key: 'outstanding', width: 14, total: true, money: true },
    ];
    const lead: SchoolSheetColumn[] = [
      { header: 'Fee date', key: 'fee_date', width: 13 },
      { header: 'Heads', key: 'head_count', width: 9, total: true },
    ];
    const flat = (r: FeeDateClassRow) => {
      const out: Record<string, string | number> = {
        campus: r.campus,
        class_name: r.class_name,
        fee_date: r.fee_date ?? 'No fee date',
        head_count: r.head_count,
        billed: r.billed,
        discount_count: r.discount_count,
        discount: r.discount,
        amount: r.amount,
        amount_paid: r.amount_paid,
        waived: r.waived,
        outstanding: r.outstanding,
      };
      for (const [name, amount] of r.heads) out[headKey(name)] = amount;
      return out;
    };

    const tabs = await this.campusTabs();
    const byCampus = new Map<string, FeeDateClassRow[]>();
    for (const r of rows) {
      if (!byCampus.has(r.campus)) byCampus.set(r.campus, []);
      byCampus.get(r.campus)!.push(r);
    }
    const sheets: SchoolSheet[] = [...byCampus.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([campus, campusRows]) => {
        const present = new Set(campusRows.flatMap((r) => [...r.heads.keys()]));
        const groups = new Map<string, { label: string; rows: Array<Record<string, string | number>> }>();
        for (const r of campusRows) {
          const key = `${r.class_id ?? 'none'}`;
          if (!groups.has(key)) groups.set(key, { label: r.class_id == null ? 'NO CLASS' : `CLASS ${r.class_name}`.toUpperCase(), rows: [] });
          groups.get(key)!.rows.push(flat(r));
        }
        const groupList = [...groups.values()];
        return {
          tab: tabs.get(campus) ?? campus,
          campus: campusLine(campus),
          columns: [...lead, ...headColumns(heads.filter((h) => present.has(h))), ...tail],
          groups: groupList,
          rows: groupList.flatMap((g) => g.rows),
          rowNoun: ['FEE DATE', 'FEE DATES'] as [string, string],
          defaulterNumbers: true,
        };
      });

    // CSV (and the column list behind it): one flat line per campus, class and fee date.
    const columns: ExportColumn[] = [
      { header: 'Campus', key: 'campus', width: 24 },
      { header: 'Class', key: 'class_name', width: 14 },
      ...[...lead, ...headColumns(heads), ...tail].map((c) => ({
        header: c.group ? `${c.group} ${c.header}` : c.header,
        key: c.key,
        width: c.width,
      })),
    ];
    return this.buildSchoolExportFile(
      'Fee Heads by Fee Date',
      'FEE HEADS REPORT — BY FEE DATE',
      `fee-heads-by-fee-date-${query.from_date}-to-${query.to_date}`,
      columns,
      rows.map(flat),
      query,
      this.feeHeadsFilterWords(query),
      user,
      sheets,
    );
  }

  /**
   * The By fee date rollup one level down (TAFSD-341): one row per campus,
   * class and fee date, with billed split by fee head. Same money rules as
   * listFeeHeadsByFeeDate — billed is heads before discount, discount its own
   * negative column, paid is cash only (netPaid), waived netted out of
   * outstanding — so the rows add back up to that rollup.
   */
  private async loadFeeDateClassRows(
    query: ListFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<{ rows: FeeDateClassRow[]; heads: string[] }> {
    const leaf = this.feeHeadsLeafWhere(query);
    const studentWhere = this.buildStudentWhere(query, user);
    const [students, groups, feeTypes] = await Promise.all([
      this.prisma.students.findMany({
        where: { ...studentWhere, student_fees: { some: leaf } },
        select: {
          cc: true,
          class_id: true,
          classes: { select: { description: true } },
          campuses: { select: { campus_name: true } },
        },
      }),
      this.prisma.student_fees.groupBy({
        by: ['student_id', 'fee_date', 'fee_type_id', 'is_discount', 'status'],
        where: { ...leaf, students: studentWhere },
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
      }),
      this.prisma.fee_types.findMany({ select: { id: true, description: true, priority_order: true } }),
    ]);
    const studentOf = new Map(students.map((st) => [st.cc, st]));
    const feeTypeName = new Map(feeTypes.map((ft) => [ft.id, ft.description.trim() || 'OTHER']));
    // Head columns in the fee types' own priority order, then name.
    const rank = new Map(
      [...feeTypes]
        .sort((a, b) => (a.priority_order ?? 1e9) - (b.priority_order ?? 1e9) || a.id - b.id)
        .map((ft, i) => [ft.description.trim() || 'OTHER', i]),
    );

    type Acc = FeeDateClassRow & { headsPaid: number; discountConsumed: number };
    const acc = new Map<string, Acc>();
    for (const g of groups) {
      const st = studentOf.get(g.student_id);
      const campus = st?.campuses?.campus_name?.trim() || 'Unassigned';
      const classId = st?.class_id ?? null;
      const feeDate = this.formatDateOnly(g.fee_date);
      const key = `${campus}|${classId ?? ''}|${feeDate ?? ''}`;
      let row = acc.get(key);
      if (!row) {
        row = {
          campus,
          class_id: classId,
          class_name: st?.classes?.description?.trim() || 'No class',
          fee_date: feeDate,
          head_count: 0,
          discount_count: 0,
          billed: 0,
          discount: 0,
          amount: 0,
          amount_paid: 0,
          waived: 0,
          outstanding: 0,
          heads: new Map(),
          headsPaid: 0,
          discountConsumed: 0,
        };
        acc.set(key, row);
      }
      const amount = this.toMoney(g._sum.amount);
      const paid = this.toMoney(g._sum.amount_paid);
      if (g.is_discount) {
        row.discount_count += g._count._all;
        row.discount = this.roundMoney(row.discount - amount);
        row.discountConsumed += paid;
        continue;
      }
      row.head_count += g._count._all;
      row.billed = this.roundMoney(row.billed + amount);
      row.headsPaid += paid;
      if (g.status === fee_status_enum.WAIVED) {
        row.waived = this.roundMoney(row.waived + this.waivedPortion(g._sum));
      }
      const name = g.fee_type_id == null ? 'OTHER' : feeTypeName.get(g.fee_type_id) ?? 'OTHER';
      row.heads.set(name, this.roundMoney((row.heads.get(name) ?? 0) + amount));
    }

    const rows = [...acc.values()].map(({ headsPaid, discountConsumed, ...row }) => {
      const amount = this.roundMoney(row.billed + row.discount);
      const amountPaid = this.netPaid(headsPaid, discountConsumed);
      return { ...row, amount, amount_paid: amountPaid, outstanding: this.roundMoney(amount - amountPaid - row.waived) };
    });
    // Campus, then class in level order (classes.id runs in level order, no
    // class last), then fee date oldest first (none last).
    rows.sort(
      (a, b) =>
        a.campus.localeCompare(b.campus) ||
        (a.class_id ?? Number.MAX_SAFE_INTEGER) - (b.class_id ?? Number.MAX_SAFE_INTEGER) ||
        (a.fee_date === b.fee_date ? 0 : a.fee_date === null ? 1 : b.fee_date === null ? -1 : a.fee_date.localeCompare(b.fee_date)),
    );
    const heads = [...new Set(rows.flatMap((r) => [...r.heads.keys()]))].sort(
      (a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || a.localeCompare(b),
    );
    return { rows, heads };
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

    return this.buildSchoolExportFile(
      'Deposits',
      'DEPOSITS REPORT',
      `deposits-report-${query.from_date}-to-${query.to_date}`,
      columns,
      data,
      query,
      this.depositsFilterWords(query),
      user,
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
    const maxMonthsBehind = query.max_months_behind;
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, options.maxLimit ?? 5000);

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
      const moneyRow = money.get(elig.student_id);
      // A voucher whose status went stale (left EXPIRED or PARTIALLY_PAID
      // after every head and surcharge on it was paid) owes nothing: not a
      // defaulter, rather than a row with a defaulting amount of 0 (TAFSD-336).
      if (!moneyRow && elig.lps_outstanding <= 0) continue;
      rows.push({
        ...elig,
        ...(moneyRow ?? EMPTY_MONEY),
        severity: bandForMonthsBehind(elig.months_behind, elig.category),
        student,
      });
    }

    // EXPIRING rows are months_behind = 0 by construction. Under the default
    // filter (min 1, no max) they stay — dropping them would hide the exact
    // early-warning case that category exists to surface. Once the admin asks
    // for a specific months range ("4 & 5 months"), a student with no
    // defaulted months is not in it.
    if (minMonthsBehind > 1 || maxMonthsBehind != null) {
      rows = rows.filter(
        (r) =>
          r.category !== 'EXPIRING' &&
          r.months_behind >= minMonthsBehind &&
          (maxMonthsBehind == null || r.months_behind <= maxMonthsBehind),
      );
    }
    if (query.severity?.length) {
      const wanted = new Set(query.severity);
      rows = rows.filter((r) => wanted.has(r.severity));
    }
    // A named month: only students carrying an arrear that fell due that month
    // (by fee_date). EXPIRING students have nothing rolled into arrears yet, so
    // they are not in it — same reasoning as the months-behind range above.
    let owedInMonth: Map<number, number> | null = null;
    if (query.arrear_month) {
      owedInMonth = await this.loadOwedInFeeMonth(
        rows.filter((r) => r.category !== 'EXPIRING').map((r) => r.student_id),
        query.arrear_month,
        asOfDate,
      );
      rows = rows.filter((r) => r.category !== 'EXPIRING' && owedInMonth!.has(r.student_id));
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
    const pageItems = await this.buildDefaulterStudentRows(pageRows, columns, classTerms, asOfDate);
    const lastNotified = await this.loadLastDefaulterNotices(pageItems.map((item) => item.cc));
    const items = pageItems.map((item) => ({
      ...item,
      arrear_month_owed: owedInMonth?.get(item.cc) ?? null,
      // TAFSD-384: the latest "Notify through app" for this student, if any.
      last_notified: lastNotified.get(item.cc) ?? null,
    }));

    return {
      ...shared,
      items,
      pagination: createPaginationMeta(page, limit, sorted.length),
    };
  }

  /** TAFSD-384: latest defaulter notice per student, plus how many were sent. */
  private async loadLastDefaulterNotices(ccs: number[]) {
    const out = new Map<number, { sent_at: Date; sent_by_name: string | null; count: number }>();
    if (ccs.length === 0) return out;
    const rows = await this.prisma.defaulter_notifications.findMany({
      where: { student_id: { in: ccs } },
      orderBy: { sent_at: 'desc' },
      select: { student_id: true, sent_at: true, sent_by_name: true },
    });
    for (const r of rows) {
      const prev = out.get(r.student_id);
      if (prev) prev.count += 1;
      else out.set(r.student_id, { sent_at: r.sent_at, sent_by_name: r.sent_by_name, count: 1 });
    }
    return out;
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
   * are no longer current. WAIVED vouchers are written off the same way —
   * their surcharge rows are all waived and nothing on them is owed.
   */
  private async loadDefaulterEligibility(
    ids: number[],
  ): Promise<Map<number, DefaulterEligibility>> {
    const result = new Map<number, DefaulterEligibility>();
    if (ids.length === 0) return result;

    const vouchers = await this.prisma.vouchers.findMany({
      where: { student_id: { in: ids }, status: { notIn: ['VOID', 'PAID', 'WAIVED'] } },
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
   * The defaulter money predicate on `sf`: a head counts when it was dated
   * before as_of, or when it sits on an EXPIRED voucher. The second covers a
   * bill issued ahead of its month (November tuition billed in October) that
   * lapsed unpaid: the family is on the report for it, so its amount must be
   * too (TAFSD-336 — those rows showed a defaulting amount of 0).
   */
  private owedByAsOfSql(asOfDate: string) {
    return Prisma.sql`(
      sf.fee_date < ${asOfDate}::date
      OR EXISTS (
        SELECT 1 FROM public.voucher_heads vh
        JOIN public.vouchers v ON v.id = vh.voucher_id
        WHERE vh.student_fee_id = sf.id AND v.status = 'EXPIRED'
      )
    )`;
  }

  /**
   * Money for a set of already-eligible students: every unpaid, non-discount
   * head dated before as_of, or on an expired voucher (owedByAsOfSql). Independent of months_behind —
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
        AND ${this.owedByAsOfSql(asOfDate)}
        AND sf.is_arrear_surcharge = false
        AND sf.is_discount = false
        AND sf.status <> 'PAID'
        AND sf.status <> 'DISCOUNT'
        AND sf.status <> 'WAIVED'
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

  /**
   * Per student, what is still owed on heads whose fee_date falls in `month`
   * ("YYYY-MM") and before as_of — the same head predicate as
   * loadDefaulterMoney, narrowed to one billing month. Students owing nothing
   * that month are absent.
   */
  private async loadOwedInFeeMonth(
    ids: number[],
    month: string,
    asOfDate: string,
  ): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (ids.length === 0) return result;
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const to = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
    const rows = await this.prisma.$queryRaw<Array<{ student_id: number; owed: number }>>(Prisma.sql`
      SELECT sf.student_id,
             SUM(COALESCE(sf.amount, sf.amount_before_discount, 0) - COALESCE(sf.amount_paid, 0))::float8 AS owed
      FROM public.student_fees sf
      WHERE sf.student_id IN (${Prisma.join(ids)})
        AND sf.fee_date >= ${from}::date
        AND sf.fee_date < ${to}::date
        AND sf.fee_date < ${asOfDate}::date
        AND sf.is_arrear_surcharge = false
        AND sf.is_discount = false
        AND sf.status <> 'PAID'
        AND sf.status <> 'DISCOUNT'
        AND sf.status <> 'WAIVED'
        AND COALESCE(sf.amount, sf.amount_before_discount, 0) - COALESCE(sf.amount_paid, 0) > 0
      GROUP BY sf.student_id
    `);
    for (const r of rows) result.set(Number(r.student_id), this.roundMoney(Number(r.owed)));
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
        campus_code: student.campuses?.campus_code ?? '',
        class_id: this.effectiveClassId(student),
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
      // A waived head is a written-off — billed for the month but nothing owed.
      const isWaived = head.status === fee_status_enum.WAIVED;
      const outstanding = isWaived ? 0 : this.headOutstanding(head);
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
        // The strip is not exported — the students sheet builds its own
        // per-month breakdown (loadDefaulterOwedMonths), unbounded by a window.
        strip_months: 1,
      } as ListDefaultersQueryDto,
      user,
      { maxLimit: EXPORT_ROW_CAP + 1 },
    );

    const items = data.items as Array<Record<string, unknown>>;
    this.assertExportCap(items.length);
    const basename = `defaulters-${view}-as-of-${data.as_of_date}`;
    // TAFSD-417: the PDF is a print of the students sheet; the summaries stay Excel / CSV.
    if (query.format === 'pdf' && view !== 'students') {
      throw new BadRequestException('PDF is available for the students sheet only. Export Excel or CSV for this view.');
    }
    if (query.format === 'pdf' && items.length > PDF_EXPORT_ROW_CAP) {
      throw new BadRequestException(
        `PDF export is limited to ${PDF_EXPORT_ROW_CAP.toLocaleString()} students (this has ${items.length.toLocaleString()}). Narrow the filters or export Excel.`,
      );
    }
    const tableFormat = query.format === 'pdf' ? undefined : query.format;

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
        tableFormat,
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
          { header: 'Expired Bills', key: 'expiring', width: 14 },
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
        tableFormat,
      );
    }

    return this.buildDefaultersStudentReport(items, data.as_of_date, query, basename, user);
  }

  /**
   * The school's own defaulter sheet ("AT A GLANCE CONSOLIDATED DEFAULTERS'
   * LIST" under the school name for its class group — see
   * defaulter-sheet-heading.ts — then campus, session and "4 & 5 MONTHS
   * DEFAULTERS"): one worksheet per campus, students in level
   * order, one column per owed calendar month, DEFAULTING AMOUNT, REMARKS and
   * a TOTAL row. Black-on-white and print-ready, like the paper original.
   *
   * The month cells come from exactly the heads loadDefaulterMoney sums into
   * arrears_outstanding (loadDefaulterOwedMonths uses the same predicate),
   * placed in their term-aware calendar month. Not from the on-screen strip:
   * that window is a fixed N months back from as_of, so it drops older owed
   * months (a year billed on one fee_date) and the row would no longer add up.
   * Built this way, DEFAULTING AMOUNT = sum of the row's month cells = the
   * on-screen Arrears figure, and TOTAL = sum of DEFAULTING AMOUNT.
   *
   * The sheet is exactly what the page shows for the same filters: the same
   * students (EXPIRING ones included, marked in REMARKS), in the same sort
   * order, with the same month window (strip_months back from as_of). Owed
   * months outside that window are summed into EARLIER / LATER columns so
   * the row still adds up.
   */
  private async buildDefaultersStudentReport(
    allItems: Array<Record<string, unknown>>,
    asOfDate: string,
    query: ExportDefaultersQueryDto,
    basename: string,
    generatedBy?: Pick<IJwtStaffPayload, 'sub' | 'username' | 'fullName'>,
  ): Promise<ExportFile> {
    const items = allItems;
    const owedByStudent = await this.loadDefaulterOwedMonths(
      items.map((r) => Number(r.cc)),
      asOfDate,
    );
    const rows: StudentMonthRow[] = [];
    for (const item of items) {
      const months = owedByStudent.get(Number(item.cc)) ?? new Map();
      const total = this.roundMoney([...months.values()].reduce((s, m) => s + m.owed, 0));
      // Rows keep listDefaulters' order — the sort the admin picked on screen.
      rows.push({ item, months, total });
    }
    // The month window: months_back (TAFSD-355, picked at export) or else the
    // page's strip_months, in calendar months ending at as_of's month. Month
    // index = year * 12 + (month - 1), as loadDefaulterOwedMonths keys them.
    const asOfYm = this.parseYearMonthOfDate(asOfDate);
    const windowHi = asOfYm.year * 12 + (asOfYm.month - 1);
    const windowLo = windowHi - (Math.min(Math.max(query.months_back ?? query.strip_months ?? 12, 1), 24) - 1);
    // The months line only when months behind or the arrear month was filtered;
    // the other filters follow it in words (TAFSD-291).
    const monthsLine =
      query.arrear_month || (query.min_months_behind ?? 1) > 1 || query.max_months_behind != null
        ? this.defaulterFilterSubtitle(query)
        : null;
    return this.buildStudentMonthReport(rows, {
      query,
      basename,
      generatedBy,
      asOfDate,
      listTitle: DEFAULTER_SHEET_LIST_TITLE,
      window: { lo: windowLo, hi: windowHi },
      amountColumns: [
        { header: 'DEFAULTING AMOUNT', csvHeader: 'Defaulting Amount', width: 15, value: (r) => r.total },
      ],
      // TAFSD-418: say what the EARLIER / LATER cells hold, so LATER doesn't
      // read as future months on a list of missed money.
      remark: (r) =>
        [
          ...(r.item.category === 'EXPIRING' ? ['UNPAID PAST EXPIRY DATE — BECOMES ARREARS ON NEXT VOUCHER'] : []),
          ...defaulterWindowRemarks(r.months.keys(), { lo: windowLo, hi: windowHi }),
        ].join('; '),
      leadLine: monthsLine,
      filterLines: (names, omitClasses, groupLine) =>
        defaulterFilterLines(query, names, monthsLine, omitClasses, undefined, groupLine),
      emptyMessage: 'No defaulters match the current filters.',
      emptySheetName: 'Defaulters',
    });
  }

  /**
   * The school's per-student month sheet, shared by the defaulters export and
   * the fee date report (TAFSD-341): one worksheet per campus, a title block
   * (school by class group, list title, campus, session, DAY / DATE, generated
   * by, filters), then one row per student — the fixed columns, one column per
   * calendar month (or per fee head under each month with breakdown_by_head),
   * the report's amount columns and REMARKS — with group headings, SUBTOTALs
   * and a TOTAL row. Black-on-white and print-ready, like the paper original.
   *
   * What a month cell holds is the caller's: owed for defaulters, billed for
   * the fee date report. `partial` prints it "BP 10940" and stays numeric.
   */
  private async buildStudentMonthReport(
    sheetRows: StudentMonthRow[],
    opts: StudentMonthReportOptions,
  ): Promise<ExportFile> {
    type Item = Record<string, unknown>;
    type SheetRow = StudentMonthRow;
    const { query, basename, generatedBy, asOfDate } = opts;
    const items = sheetRows.map((r) => r.item);
    const siblingGrs = await this.loadSiblingGrNumbers(items.map((r) => Number(r.cc)));
    const linkToGr = (r: Item) => (siblingGrs.get(Number(r.cc)) ?? []).join(', ');
    // TAFSD-340: "FATHER 0312-2244523", one per guardian, primary contact first.
    const contacts = query.columns?.length && !query.columns.includes('contact')
      ? new Map<number, string[]>()
      : await this.loadDefaulterContacts(items.map((r) => Number(r.cc)));
    const contactFor = (r: Item) => contacts.get(Number(r.cc)) ?? [];
    const statusFor = (r: Item) => DEFAULTER_STATUS_LABELS[String(r.student_status ?? '')] ?? '';

    const byCampus = new Map<string, { code: string; name: string; rows: SheetRow[] }>();
    for (const row of sheetRows) {
      const code = String(row.item.campus_code ?? '').trim();
      const name = String(row.item.campus ?? '').trim() || 'Unassigned';
      const key = code || name;
      if (!byCampus.has(key)) byCampus.set(key, { code, name, rows: [] });
      byCampus.get(key)!.rows.push(row);
    }
    const campuses = [...byCampus.values()].sort((a, b) =>
      (a.code || a.name).localeCompare(b.code || b.name),
    );

    const level = (r: Item) =>
      [
        DEFAULTER_LEVEL_ABBREVIATIONS[String(r.class_name ?? '').trim()] ?? String(r.class_name ?? '').trim(),
        String(r.section ?? '').trim(),
      ]
        .filter(Boolean)
        .join(' ');
    const windowHi = opts.window.hi;
    const windowLo = opts.window.lo;
    type SheetCol = { label: string; from: number; to: number };
    const sheetColumns = (rows: SheetRow[]): SheetCol[] => {
      let earlier = false;
      let later = false;
      for (const r of rows) {
        for (const idx of r.months.keys()) {
          if (idx < windowLo) earlier = true;
          if (idx > windowHi) later = true;
        }
      }
      const span = windowHi - windowLo + 1;
      const cols: SheetCol[] = [];
      if (earlier) cols.push({ label: 'EARLIER', from: Number.NEGATIVE_INFINITY, to: windowLo - 1 });
      for (let idx = windowLo; idx <= windowHi; idx++) {
        // "DEC", "JAN" … as on the paper sheet; the year is added only when
        // the window is long enough for a month name to repeat.
        const name = MONTH_ABBR_UPPER[idx % 12];
        cols.push({ label: span > 12 ? `${name} ${String(Math.floor(idx / 12)).slice(-2)}` : name, from: idx, to: idx });
      }
      if (later) cols.push({ label: 'LATER', from: windowHi + 1, to: Number.POSITIVE_INFINITY });
      return cols;
    };
    const cellFor = (r: SheetRow, col: SheetCol) => {
      let owed = 0;
      let partial = false;
      // Per head name, summed across the months this column covers (EARLIER /
      // LATER span several), in the order the heads were first seen.
      const heads = new Map<string, { owed: number; partial: boolean }>();
      for (const [idx, m] of r.months) {
        if (idx < col.from || idx > col.to) continue;
        owed += m.owed;
        partial = partial || m.partial;
        for (const h of m.heads) {
          const acc = heads.get(h.name) ?? { owed: 0, partial: false };
          acc.owed = this.roundMoney(acc.owed + h.owed);
          acc.partial = acc.partial || h.partial;
          heads.set(h.name, acc);
        }
      }
      return owed > 0 ? { owed: this.roundMoney(owed), partial, heads } : null;
    };
    // TAFSD-293/335: with the breakdown on, each month column becomes a group
    // of sub-columns, one per fee head owed in it, then the month's TOTAL.
    const breakdown = Boolean(query.breakdown_by_head);
    // Heads in the order first seen, walking months oldest first, so every
    // month group lists its heads in the same order.
    const headOrder = (rows: SheetRow[]) => {
      const order = new Map<string, number>();
      for (const r of rows) {
        for (const idx of [...r.months.keys()].sort((a, b) => a - b)) {
          for (const h of r.months.get(idx)!.heads) if (!order.has(h.name)) order.set(h.name, order.size);
        }
      }
      return order;
    };
    /** The heads owed in this column by at least one of the rows. */
    const headsIn = (rows: SheetRow[], col: SheetCol, order: Map<string, number>) => {
      const names = new Set<string>();
      for (const r of rows) for (const name of cellFor(r, col)?.heads.keys() ?? []) names.add(name);
      return [...names].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    };
    const remarkFor = opts.remark;
    // A class or segment filter narrows the sheet to part of the school; without
    // one it is the whole school and gets the plain name.
    const classFiltered = Boolean(query.class_id?.length || query.segment_id?.length);

    // TAFSD-337: groups within each campus sheet, in class order (classes.id
    // runs in level order), then section, then household name. Rows keep the
    // on-screen sort inside their group.
    const groupBy: DefaulterGroupBy | undefined = query.group_by;
    const families = groupBy === 'family' ? await this.loadDefaulterFamilies(items.map((r) => Number(r.cc))) : null;
    type SheetGroup = { label: string; rows: SheetRow[] };
    const groupsOf = (rows: SheetRow[]): SheetGroup[] => {
      if (!groupBy) return [{ label: '', rows }];
      const byKey = new Map<string, { label: string; sort: Array<number | string>; rows: SheetRow[] }>();
      for (const r of rows) {
        const classId = r.item.class_id == null ? Number.MAX_SAFE_INTEGER : Number(r.item.class_id);
        const className = String(r.item.class_name ?? '').trim() || 'No class';
        const section = String(r.item.section ?? '').trim();
        let key: string;
        let label: string;
        let sort: Array<number | string>;
        if (groupBy === 'class') {
          key = String(classId);
          label = `CLASS ${className}`.toUpperCase();
          sort = [classId];
        } else if (groupBy === 'section') {
          key = `${classId}:${section}`;
          label = `${className} ${section || '(no section)'}`.toUpperCase();
          sort = [classId, section];
        } else {
          const fam = families?.get(Number(r.item.cc));
          key = fam ? `f${fam.id}` : `s${r.item.cc}`;
          label = fam ? `${fam.household_name} · #${fam.id}`.toUpperCase() : 'NO FAMILY ON FILE';
          sort = [fam ? fam.household_name.toUpperCase() : '￿', fam?.id ?? Number(r.item.cc)];
        }
        if (!byKey.has(key)) byKey.set(key, { label, sort, rows: [] });
        byKey.get(key)!.rows.push(r);
      }
      const cmp = (a: Array<number | string>, b: Array<number | string>) => {
        for (let i = 0; i < a.length; i++) {
          if (a[i] === b[i]) continue;
          return typeof a[i] === 'number' && typeof b[i] === 'number'
            ? (a[i] as number) - (b[i] as number)
            : String(a[i]).localeCompare(String(b[i]));
        }
        return 0;
      };
      return [...byKey.values()].sort((a, b) => cmp(a.sort, b.sort)).map(({ label, rows: groupRows }) => ({ label, rows: groupRows }));
    };
    const groupLine = groupBy ? [`GROUPED BY ${groupBy.toUpperCase()}`] : [];

    // TAFSD-301: the columns the user picked, in the standard order. None
    // picked (the param omitted) is the full sheet, as before.
    const picked = new Set<DefaulterColumnKey>(query.columns?.length ? query.columns : DEFAULTER_COLUMN_KEYS);
    const show = (key: DefaulterColumnKey) => picked.has(key);
    // The report's money columns ("amount" in the picker): DEFAULTING AMOUNT for
    // defaulters; AMOUNT, PAID and BALANCE for the fee date report.
    const amountColumns = show('amount') ? opts.amountColumns : [];

    if (query.format === 'csv') {
      const order = headOrder(sheetRows);
      // One CSV column per month, or per month head plus the month TOTAL.
      const monthCols: Array<{ header: string; value: (r: SheetRow) => number | '' }> = [];
      for (const col of show('months') ? sheetColumns(sheetRows) : []) {
        if (!breakdown) {
          monthCols.push({ header: col.label, value: (r) => cellFor(r, col)?.owed ?? '' });
          continue;
        }
        for (const name of headsIn(sheetRows, col, order)) {
          monthCols.push({
            header: `${col.label} ${name.toUpperCase()}`,
            value: (r) => cellFor(r, col)?.heads.get(name)?.owed ?? '',
          });
        }
        monthCols.push({ header: `${col.label} TOTAL`, value: (r) => cellFor(r, col)?.owed ?? '' });
      }
      const fixed: Array<[DefaulterColumnKey, string, (r: SheetRow, i: number) => string | number]> = [
        ['sno', 'S#', (_r, i) => i + 1],
        ['cc', 'C.C.', (r) => Number(r.item.cc)],
        ['gr', 'G.R.#', (r) => String(r.item.gr_number ?? '')],
        ['link_to_gr', 'Link to GR', (r) => linkToGr(r.item)],
        ['level', 'Level', (r) => level(r.item)],
        ['name', 'Student Name', (r) => String(r.item.student_name ?? '')],
        ['status', 'Status', (r) => statusFor(r.item)],
        ['contact', 'Contact', (r) => contactFor(r.item).join(', ')],
      ];
      const before = fixed.filter(([k]) => show(k));
      const header = [
        'Campus',
        ...(groupBy ? ['Group'] : []),
        ...before.map(([, h]) => h),
        ...monthCols.map((c) => c.header),
        ...amountColumns.map((c) => c.csvHeader),
        ...(show('remarks') ? ['Remarks'] : []),
      ];
      const lines = [header.map((h) => this.csvCell(h)).join(',')];
      for (const campus of campuses) {
        for (const group of groupsOf(campus.rows)) {
          group.rows.forEach((r, i) => {
            const cells = [
              this.defaulterCampusLabel(campus.code, campus.name),
              ...(groupBy ? [group.label] : []),
              ...before.map(([, , v]) => v(r, i)),
              ...monthCols.map((c) => c.value(r)),
              ...amountColumns.map((c) => c.value(r)),
              ...(show('remarks') ? [remarkFor(r)] : []),
            ];
            lines.push(cells.map((v) => this.csvCell(v)).join(','));
          });
        }
      }
      return {
        buffer: Buffer.from(`﻿${lines.join('\n')}`, 'utf8'),
        filename: `${basename}.csv`,
        contentType: 'text/csv; charset=utf-8',
      };
    }

    const filterNames = await this.loadDefaulterFilterNames(query);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'The American Foundation School';

    const [y, m, d] = asOfDate.split('-').map(Number);
    const asOf = new Date(Date.UTC(y, m - 1, d));
    const dayLine = `DAY :${asOf.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }).toUpperCase()}`;
    const dateLine = `DATE : ${asOf
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
      .toUpperCase()}`;
    // TAFSD-338: when and by whom, under DAY / DATE.
    const generatedLine = `GENERATED ON ${this.formatPktDateTime(new Date())}${
      generatedBy ? ` BY ${await this.staffLabel(generatedBy)}` : ''
    }`;

    if (campuses.length === 0) {
      // Still a workbook, so the admin sees "nothing matched" rather than an
      // opaque download failure.
      writeEmptySheet(workbook, opts.emptySheetName, opts.emptyMessage);
      return this.studentMonthReportFile(workbook, query, basename, opts.listTitle, opts.tooWideHint);
    }

    const SERIF = 'Times New Roman';
    const thin: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FF000000' } };
    const box: Partial<ExcelJS.Borders> = { top: thin, left: thin, bottom: thin, right: thin };

    for (const campus of campuses) {
      const sheet = workbook.addWorksheet(this.sanitizeSheetName(campus.code || campus.name));
      // Column specs in the standard order, narrowed to the picked ones
      // (TAFSD-301). The months expand to one column per month.
      type Spec = {
        header: string;
        width: number;
        /** Text that may run long: wrap it. */
        wrap?: boolean;
        /** Summed into the TOTAL row. */
        total?: (r: SheetRow) => number;
        fill: (cell: ExcelJS.Cell, r: SheetRow, i: number) => number | void;
        amount?: boolean;
        month?: boolean;
        /** Breakdown: the month label this head sub-column sits under. */
        group?: string;
        /** Breakdown: the month's TOTAL sub-column. */
        monthTotal?: boolean;
      };
      const specs: Spec[] = [];
      if (show('sno')) specs.push({ header: 'S#', width: 5, fill: (c, _r, i) => void (c.value = i + 1) });
      if (show('cc')) specs.push({ header: 'C.C.', width: 8, fill: (c, r) => void (c.value = Number(r.item.cc)) });
      if (show('gr'))
        specs.push({
          header: 'G.R. #',
          width: 8,
          fill: (c, r) => {
            const gr = String(r.item.gr_number ?? '').trim();
            c.value = /^\d+$/.test(gr) ? Number(gr) : gr;
          },
        });
      if (show('link_to_gr'))
        specs.push({
          header: 'LINK TO GR',
          width: 14,
          wrap: true,
          fill: (c, r) => void (c.value = linkToGr(r.item)),
        });
      if (show('level')) specs.push({ header: 'LEVEL', width: 11, fill: (c, r) => void (c.value = level(r.item)) });
      if (show('name'))
        specs.push({
          header: 'STUDENT NAME',
          width: 30,
          wrap: true,
          fill: (c, r) => void (c.value = String(r.item.student_name ?? '').toUpperCase()),
        });
      if (show('status')) specs.push({ header: 'STATUS', width: 11, fill: (c, r) => void (c.value = statusFor(r.item)) });
      if (show('contact'))
        specs.push({
          header: 'CONTACT',
          width: 24,
          wrap: true,
          fill: (c, r) => {
            const lines = contactFor(r.item);
            c.value = lines.join('\n');
            return lines.length;
          },
        });
      if (show('months')) {
        const order = headOrder(campus.rows);
        for (const col of sheetColumns(campus.rows)) {
          const monthCell = (cell: ExcelJS.Cell, r: SheetRow) => {
            const owed = cellFor(r, col);
            if (!owed) return;
            cell.value = owed.owed;
            // Part-paid month: the remaining balance, shown "BP 10940" as on
            // the manual sheets. Still a number, so the row sums.
            cell.numFmt = owed.partial ? '"BP "0' : '0';
          };
          if (!breakdown) {
            specs.push({ header: col.label, width: 10, month: true, total: (r) => cellFor(r, col)?.owed ?? 0, fill: monthCell });
            continue;
          }
          for (const name of headsIn(campus.rows, col, order)) {
            specs.push({
              group: col.label,
              header: headerText(name),
              width: 11,
              month: true,
              total: (r) => cellFor(r, col)?.heads.get(name)?.owed ?? 0,
              fill: (cell, r) => {
                const head = cellFor(r, col)?.heads.get(name);
                if (!head) return;
                cell.value = head.owed;
                cell.numFmt = head.partial ? '"BP "0' : '0';
              },
            });
          }
          specs.push({
            group: col.label,
            header: 'TOTAL',
            width: 11,
            month: true,
            monthTotal: true,
            total: (r) => cellFor(r, col)?.owed ?? 0,
            fill: monthCell,
          });
        }
      }
      for (const amountCol of amountColumns)
        specs.push({
          header: amountCol.header,
          width: amountCol.width,
          amount: true,
          total: amountCol.value,
          fill: (c, r) => {
            c.value = amountCol.value(r);
            c.numFmt = '0';
          },
        });
      if (show('remarks'))
        specs.push({
          header: 'REMARKS',
          width: 34,
          wrap: true,
          fill: (c, r) => void (c.value = remarkFor(r)),
        });
      const lastCol = Math.max(specs.length, 1);

      // Title block (TAFSD-289): school name by class group, the classes line
      // when the sheet mixes both schools, list title, campus, session, then
      // DAY / DATE and the filter subtitle. The header row follows.
      const heading = defaulterSheetHeading(
        campus.rows.map((r) => ({
          class_id: r.item.class_id == null ? null : Number(r.item.class_id),
          class_name: String(r.item.class_name ?? ''),
        })),
        classFiltered,
        opts.sessionDate ?? asOfDate,
      );
      // TAFSD-425: the title block every school sheet shares.
      let line = writeTitleBlock(sheet, lastCol, 1, {
        school: heading.school,
        classesLine: heading.classesLine,
        title: opts.listTitle,
        campus: campusLine(campus.name) || this.defaulterCampusLabel(campus.code, campus.name),
        session: heading.session,
      });
      const banner = (text: string, size: number, height: number) => {
        line = writeBanner(sheet, lastCol, line, text, size, height);
      };

      line++;
      for (const text of [dayLine, dateLine, generatedLine]) {
        const cell = sheet.getCell(line, 1);
        cell.value = text;
        cell.font = { name: 'Arial', bold: true, size: 11 };
        sheet.getRow(line++).height = 16;
      }
      line++;
      const leadLine = opts.leadLine;
      const filterLines = opts.filterLines(filterNames, heading.classesLine != null, groupLine);
      filterLines.forEach((text, i) => banner(text, i === 0 && leadLine ? 14 : 12, i === 0 && leadLine ? 22 : 18));

      // Breakdown sheets have two header rows: the month over its head
      // sub-columns, and the head names under it. Other columns span both.
      const HEADER_ROW = line;
      const twoRowHeader = specs.some((spec) => spec.group);
      const HEADER_LAST = twoRowHeader ? HEADER_ROW + 1 : HEADER_ROW;
      const styleHeader = (cell: ExcelJS.Cell, text: string, size: number) => {
        cell.value = text;
        cell.font = { name: SERIF, bold: true, size };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = box;
      };
      specs.forEach((spec, i) => {
        const col = i + 1;
        sheet.getColumn(col).width = spec.width;
        if (!spec.group) {
          if (twoRowHeader) {
            sheet.getCell(HEADER_LAST, col).border = box;
            sheet.mergeCells(HEADER_ROW, col, HEADER_LAST, col);
          }
          styleHeader(sheet.getCell(HEADER_ROW, col), spec.header, spec.amount ? 11 : 13);
          return;
        }
        styleHeader(sheet.getCell(HEADER_LAST, col), spec.header, 10);
        // First sub-column of its month: write the month and merge across the group.
        if (specs[i - 1]?.group === spec.group) return;
        let end = i;
        while (specs[end + 1]?.group === spec.group) end++;
        for (let c = col; c <= end + 1; c++) sheet.getCell(HEADER_ROW, c).border = box;
        if (end > i) sheet.mergeCells(HEADER_ROW, col, HEADER_ROW, end + 1);
        styleHeader(sheet.getCell(HEADER_ROW, col), spec.group, 13);
      });
      sheet.getRow(HEADER_ROW).height = twoRowHeader ? 24 : 36;
      if (twoRowHeader) sheet.getRow(HEADER_LAST).height = 34;

      let rowIdx = HEADER_LAST + 1;
      const writeStudent = (r: SheetRow, i: number) => {
        const row = sheet.getRow(rowIdx);
        let lineCount = 1;
        specs.forEach((spec, c) => {
          const cell = row.getCell(c + 1);
          const lines = spec.fill(cell, r, i);
          if (typeof lines === 'number') lineCount = Math.max(lineCount, lines);
          cell.border = box;
          cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: Boolean(spec.wrap) };
          cell.font = spec.amount
            ? { name: SERIF, bold: true, size: 12 }
            : { name: SERIF, bold: Boolean(spec.monthTotal), size: spec.group ? 10 : 11 };
        });
        // Excel won't grow a row to fit wrapped text it didn't write itself.
        row.height = Math.max(22, lineCount * 14 + 6);
        rowIdx++;
      };

      // TOTAL — the grand total under the amount columns, as on the paper
      // sheet, with a labelled box over the few columns before it. Without the
      // amount columns, each month column gets its own total. A breakdown sheet
      // totals every head and month sub-column as well. Groups get the same row
      // as their SUBTOTAL.
      const totalCols = specs
        .map((spec, i) => ({ spec, col: i + 1 }))
        .filter(({ spec }) => spec.total && (spec.amount || !amountColumns.length || breakdown));
      const writeTotal = (rows: SheetRow[], text: string) => {
        if (!totalCols.length) return;
        const totalRow = sheet.getRow(rowIdx);
        const firstTotal = totalCols[0].col;
        if (firstTotal > 1) {
          const labelFrom = Math.max(1, firstTotal - 3);
          if (firstTotal - 1 > labelFrom) sheet.mergeCells(rowIdx, labelFrom, rowIdx, firstTotal - 1);
          const label = totalRow.getCell(labelFrom);
          label.value = text;
          label.font = { name: SERIF, bold: true, size: 12 };
          label.alignment = { horizontal: 'center', vertical: 'middle' };
          for (let c = labelFrom; c < firstTotal; c++) totalRow.getCell(c).border = box;
        }
        for (const { spec, col } of totalCols) {
          const cell = totalRow.getCell(col);
          cell.value = this.roundMoney(rows.reduce((sum, r) => sum + spec.total!(r), 0));
          cell.numFmt = spec.amount ? '0.00' : '0';
          cell.font = { name: SERIF, bold: true, size: 12 };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.border = box;
        }
        totalRow.height = 22;
        rowIdx++;
      };

      if (!groupBy) {
        campus.rows.forEach(writeStudent);
      } else {
        // TAFSD-337: heading, the group's students (S# restarts), SUBTOTAL,
        // then an empty row before the next group.
        for (const group of groupsOf(campus.rows)) {
          if (lastCol > 1) sheet.mergeCells(rowIdx, 1, rowIdx, lastCol);
          const heading = sheet.getCell(rowIdx, 1);
          heading.value = `${group.label} · ${group.rows.length} ${group.rows.length === 1 ? 'STUDENT' : 'STUDENTS'}`;
          heading.font = { name: SERIF, bold: true, size: 12 };
          heading.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
          heading.border = box;
          sheet.getRow(rowIdx).height = 22;
          rowIdx++;
          group.rows.forEach(writeStudent);
          writeTotal(group.rows, 'SUBTOTAL');
          rowIdx++;
        }
      }
      writeTotal(campus.rows, 'TOTAL');

      // TAFSD-425: columns and rows grow to fit what's in them, so nothing is cut off.
      fitSheetToText(sheet, HEADER_ROW, HEADER_LAST);
      sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: HEADER_LAST }];
      sheet.pageSetup = {
        paperSize: 9, // A4
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        horizontalCentered: true,
        printTitlesRow: `${HEADER_ROW}:${HEADER_LAST}`,
        margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
      };
    }

    return this.studentMonthReportFile(workbook, query, basename, opts.listTitle, opts.tooWideHint);
  }

  /** The finished per-student sheet as Excel or its PDF print (TAFSD-417/425). */
  private studentMonthReportFile(
    workbook: ExcelJS.Workbook,
    query: { format?: string; paper?: SheetPaper },
    basename: string,
    title: string,
    tooWideHint = 'Lower "months back", turn off the fee head breakdown, or untick some columns.',
  ): Promise<ExportFile> {
    return schoolWorkbookFile(workbook, query, basename, title, tooWideHint);
  }

  /**
   * Per student, what is owed per calendar month (key year*12 + month-1) —
   * exactly the heads loadDefaulterMoney sums, so the months add back up to
   * arrears_outstanding. `partial` marks a month where something was paid;
   * `heads` splits the month by fee head (TAFSD-293).
   */
  private async loadDefaulterOwedMonths(
    ids: number[],
    asOfDate: string,
  ): Promise<Map<number, Map<number, DefaulterOwedMonth>>> {
    const result = new Map<number, Map<number, DefaulterOwedMonth>>();
    if (ids.length === 0) return result;
    const classTerms = await this.loadClassTerms();

    type OwedHeadRaw = {
      student_id: number;
      target_month: number;
      academic_year: string;
      term_start_month: number | null;
      fee_date: Date;
      outstanding: number;
      amount_paid: number;
      student_status: student_status | null;
      class_id: number | null;
      graduated_from_class_id: number | null;
      head_name: string | null;
    };
    const CHUNK = 5_000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const heads = await this.prisma.$queryRaw<OwedHeadRaw[]>(Prisma.sql`
        SELECT sf.student_id, sf.target_month, sf.academic_year, sf.term_start_month, sf.fee_date,
               (COALESCE(sf.amount, sf.amount_before_discount, 0) - COALESCE(sf.amount_paid, 0))::float8
                 AS outstanding,
               COALESCE(sf.amount_paid, 0)::float8 AS amount_paid,
               s.status AS student_status, s.class_id, s.graduated_from_class_id,
               ft.description AS head_name
        FROM public.student_fees sf
        JOIN public.students s ON s.cc = sf.student_id
        LEFT JOIN public.fee_types ft ON ft.id = sf.fee_type_id
        WHERE sf.student_id IN (${Prisma.join(chunk)})
          AND sf.fee_date IS NOT NULL
          AND ${this.owedByAsOfSql(asOfDate)}
          AND sf.is_arrear_surcharge = false
          AND sf.is_discount = false
          AND sf.status <> 'PAID'
          AND sf.status <> 'DISCOUNT'
          AND sf.status <> 'WAIVED'
          AND COALESCE(sf.amount, sf.amount_before_discount, 0) - COALESCE(sf.amount_paid, 0) > 0
      `);
      for (const h of heads) {
        const resolved =
          this.resolveHeadCalendarMonth(
            {
              target_month: h.target_month,
              academic_year: h.academic_year,
              term_start_month: h.term_start_month,
              students: {
                status: h.student_status,
                class_id: h.class_id,
                graduated_from_class_id: h.graduated_from_class_id,
              },
            },
            classTerms,
          ) ??
          // Unparseable academic_year: fall back to the billing month rather
          // than drop money the DEFAULTING AMOUNT has to account for.
          { year: h.fee_date.getUTCFullYear(), month: h.fee_date.getUTCMonth() + 1 };
        const key = resolved.year * 12 + (resolved.month - 1);
        const studentId = Number(h.student_id);
        const months = result.get(studentId) ?? new Map<number, DefaulterOwedMonth>();
        const cell = months.get(key) ?? { owed: 0, partial: false, heads: [] };
        const outstanding = Number(h.outstanding);
        const paid = Number(h.amount_paid) > 0;
        cell.owed = this.roundMoney(cell.owed + outstanding);
        if (paid) cell.partial = true;
        // Same rows as the month total, so the heads always add back up to it.
        const name = (h.head_name ?? '').trim() || 'OTHER';
        const head = cell.heads.find((x) => x.name === name);
        if (head) {
          head.owed = this.roundMoney(head.owed + outstanding);
          head.partial = head.partial || paid;
        } else cell.heads.push({ name, owed: this.roundMoney(outstanding), partial: paid });
        months.set(key, cell);
        result.set(studentId, months);
      }
    }
    return result;
  }

  /** Names for the ids the export was filtered by, for the sheet's filter lines. */
  private async loadDefaulterFilterNames(
    query: Pick<StudentScopeFilterQueryDto, 'campus_id' | 'class_id' | 'section_id' | 'segment_id' | 'graduated_from_class_id'>,
  ): Promise<DefaulterFilterNames> {
    const classIds = [...(query.class_id ?? []), ...(query.graduated_from_class_id ?? [])];
    const [campuses, classes, sections, segments] = await Promise.all([
      query.campus_id?.length
        ? this.prisma.campuses.findMany({ where: { id: { in: query.campus_id } }, select: { id: true, campus_name: true } })
        : [],
      classIds.length
        ? this.prisma.classes.findMany({ where: { id: { in: classIds } }, select: { id: true, description: true } })
        : [],
      query.section_id?.length
        ? this.prisma.sections.findMany({ where: { id: { in: query.section_id } }, select: { id: true, description: true } })
        : [],
      query.segment_id?.length
        ? this.prisma.segments.findMany({ where: { id: { in: query.segment_id } }, select: { id: true, name: true } })
        : [],
    ]);
    return {
      campuses: new Map(campuses.map((c) => [c.id, c.campus_name] as [number, string])),
      classes: new Map(classes.map((c) => [c.id, c.description] as [number, string])),
      sections: new Map(sections.map((c) => [c.id, c.description] as [number, string])),
      segments: new Map(segments.map((c) => [c.id, c.name] as [number, string])),
    };
  }

  /**
   * Per student, the GR numbers of the other students in the same family
   * (students.family_id), for the sheet's LINK TO GR column. One query per
   * 5,000 students, not one per student. Deleted students and blank GRs are
   * skipped; the student's own GR is never listed.
   */
  /**
   * cc -> guardian phone numbers for the CONTACT column (TAFSD-340): each
   * guardian's primary phone (else WhatsApp), labelled by relationship,
   * primary contact first, then father, mother and the rest; duplicates
   * dropped, at most three. Falls back to the family's home phone.
   */
  private async loadDefaulterContacts(ids: number[]): Promise<Map<number, string[]>> {
    const result = new Map<number, string[]>();
    const rank = (rel: string, primary: boolean) =>
      primary ? 0 : rel === 'FATHER' ? 1 : rel === 'MOTHER' ? 2 : 3;
    const CHUNK = 5_000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const students = await this.prisma.students.findMany({
        where: { cc: { in: ids.slice(i, i + CHUNK) } },
        select: {
          cc: true,
          families: { select: { home_phone: true } },
          student_guardians: {
            select: {
              relationship: true,
              is_primary_contact: true,
              guardians: { select: { primary_phone: true, whatsapp_number: true, deleted_at: true } },
            },
          },
        },
      });
      for (const st of students) {
        const seen = new Set<string>();
        const lines: string[] = [];
        const guardians = st.student_guardians
          .filter((sg) => sg.guardians && !sg.guardians.deleted_at)
          .map((sg) => ({ ...sg, rel: sg.relationship.trim().toUpperCase() }))
          .sort((a, b) => rank(a.rel, !!a.is_primary_contact) - rank(b.rel, !!b.is_primary_contact));
        for (const sg of guardians) {
          const raw = sg.guardians.primary_phone?.trim() || sg.guardians.whatsapp_number?.trim();
          const key = normalizePkPhone(raw);
          if (!key || seen.has(key) || lines.length >= 3) continue;
          seen.add(key);
          lines.push(`${sg.rel} ${formatPkPhone(raw)}`);
        }
        const home = normalizePkPhone(st.families?.home_phone);
        if (!lines.length && home) lines.push(`HOME ${formatPkPhone(home)}`);
        if (lines.length) result.set(st.cc, lines);
      }
    }
    return result;
  }

  /** cc -> the student's family, for grouping the defaulters sheet by family (TAFSD-337). */
  private async loadDefaulterFamilies(ids: number[]): Promise<Map<number, { id: number; household_name: string }>> {
    const result = new Map<number, { id: number; household_name: string }>();
    const CHUNK = 5_000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = await this.prisma.students.findMany({
        where: { cc: { in: ids.slice(i, i + CHUNK) }, family_id: { not: null } },
        select: { cc: true, families: { select: { id: true, household_name: true } } },
      });
      for (const r of rows) {
        if (r.families) result.set(r.cc, { id: r.families.id, household_name: r.families.household_name.trim() });
      }
    }
    return result;
  }

  private async loadSiblingGrNumbers(ids: number[]): Promise<Map<number, string[]>> {
    const result = new Map<number, string[]>();
    const CHUNK = 5_000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const rows = await this.prisma.$queryRaw<Array<{ cc: number; gr_number: string }>>(Prisma.sql`
        SELECT s.cc, TRIM(sib.gr_number) AS gr_number
        FROM public.students s
        JOIN public.students sib
          ON sib.family_id = s.family_id
         AND sib.cc <> s.cc
         AND sib.deleted_at IS NULL
        WHERE s.cc IN (${Prisma.join(chunk)})
          AND s.family_id IS NOT NULL
          AND NULLIF(TRIM(sib.gr_number), '') IS NOT NULL
          AND TRIM(sib.gr_number) <> COALESCE(TRIM(s.gr_number), '')
      `);
      for (const r of rows) {
        const cc = Number(r.cc);
        const list = result.get(cc) ?? [];
        if (!list.includes(r.gr_number)) list.push(r.gr_number);
        result.set(cc, list);
      }
    }
    for (const list of result.values()) {
      list.sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b);
      });
    }
    return result;
  }

  /** What the school writes in the H2 brackets — "(G-E-J)" on their own sheets. */
  private defaulterCampusLabel(code: string, name: string): string {
    return DEFAULTER_CAMPUS_LABELS[code] ?? (code || name);
  }

  /**
   * The H3, from the months filter: "1 MONTH", "4 & 5 MONTHS",
   * "1 & 2 & 3 MONTHS", "6+ MONTHS", "4-9 MONTHS" … DEFAULTERS.
   */
  private defaulterFilterSubtitle(query: ExportDefaultersQueryDto): string {
    const range = this.defaulterMonthsRangeSubtitle(query);
    if (!query.arrear_month) return range;
    const [y, m] = query.arrear_month.split('-').map(Number);
    const monthName = new Date(Date.UTC(y, m - 1, 1))
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .toUpperCase();
    // "AUGUST 2026 DEFAULTERS", or "AUGUST 2026 · 4 & 5 MONTHS DEFAULTERS".
    return range === 'ALL DEFAULTERS' ? `${monthName} DEFAULTERS` : `${monthName} · ${range}`;
  }

  private defaulterMonthsRangeSubtitle(query: ExportDefaultersQueryDto): string {
    const min = query.min_months_behind ?? 1;
    const max = query.max_months_behind;
    if (max != null && max >= min) {
      if (min === max) return `${min} MONTH${min === 1 ? '' : 'S'} DEFAULTERS`;
      if (max - min <= 3) {
        const parts = Array.from({ length: max - min + 1 }, (_, i) => min + i);
        return `${parts.join(' & ')} MONTHS DEFAULTERS`;
      }
      return `${min}-${max} MONTHS DEFAULTERS`;
    }
    if (min > 1) return `${min}+ MONTHS DEFAULTERS`;
    return 'ALL DEFAULTERS';
  }

  /** Excel sheet names cap at 31 chars and reject []:/?\\* — Prisma campus_name is clean, but belt-and-braces. */
  private sanitizeSheetName(name: string): string {
    const cleaned = name.replace(/[\[\]:\/\?\\*]/g, ' ').trim();
    return cleaned.length > 31 ? cleaned.slice(0, 31) : cleaned || 'Sheet';
  }

  /** 1 -> A, 26 -> Z, 27 -> AA, etc. for sheet.mergeCells string form. */
  private excelColumnLetter(colIndex: number): string {
    let n = colIndex;
    let s = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
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
      'waived_count',
      'billed',
      'to_be_billed',
      'waived',
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
    return this.andUniversalScope(
      applyStudentScope(user, studentWhere, {
        campus_id: query.campus_id,
        class_id: query.class_id,
      }),
      user,
    );
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
    return this.andUniversalScope(
      applyStudentScope(user, studentWhere, {
        campus_id: query.campus_id,
        class_id: query.class_id,
      }),
      user,
    );
  }

  /**
   * ANDs the universal scope fragment on top of the legacy applyStudentScope
   * result, never replacing it — the legacy check stays live for the 90-day
   * token window (see the scope/tile-permission handoff §5b). Empty when the
   * caller has no restricting universal scope, so unrestricted users pay no
   * extra query cost.
   */
  private andUniversalScope(
    legacy: Prisma.studentsWhereInput,
    user: IJwtStaffPayload,
  ): Prisma.studentsWhereInput {
    const universal = this.scope.whereForStudents(user);
    return Object.keys(universal).length === 0 ? legacy : { AND: [legacy, universal] };
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
   * Paid nets the discount out the same way — see netPaid.
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
        _sum: { amount: true, amount_paid: true },
        _count: true,
      }),
      this.prisma.student_fees.groupBy({
        by: ['status'],
        where: nonDiscountWhere,
        _sum: { amount: true, amount_paid: true },
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
    let waived = 0;
    let waivedCount = 0;
    for (const row of byStatus) {
      const amount = this.toMoney(row._sum.amount);
      const count = row._count._all;
      if ((row.status ?? fee_status_enum.NOT_ISSUED) === fee_status_enum.NOT_ISSUED) {
        toBeBilled = this.roundMoney(toBeBilled + amount);
        toBeBilledCount += count;
      } else if (row.status === fee_status_enum.WAIVED) {
        // Waived heads are a permanent write-off — their own bucket, excluded
        // from to-be-billed and netted out of Outstanding below. A head waived
        // after a part-payment keeps that cash: the paid part stays billed and
        // only the remainder is waived, so both reconciliation identities in
        // buildTotalsCheck still hold.
        const portion = this.waivedPortion(row._sum);
        waived = this.roundMoney(waived + portion);
        billed = this.roundMoney(billed + amount - portion);
        waivedCount += count;
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
    const amountPaid = this.netPaid(totalsAgg._sum.amount_paid, discAgg._sum.amount_paid);
    return {
      count: totalsAgg._count + discAgg._count,
      billed_count: billedCount,
      to_be_billed_count: toBeBilledCount,
      waived_count: waivedCount,
      billed,
      to_be_billed: toBeBilled,
      waived,
      amount,
      amount_paid: amountPaid,
      outstanding: this.roundMoney(amount - amountPaid - waived),
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
    // A discount row's amount_paid is the part of it already spent settling heads;
    // it shows as negative paid so it cancels the discount-settled part of those
    // heads' paid (see netPaid). Fully used: amount -X, paid -X, outstanding 0.
    const amountPaid = row.is_discount ? this.netPaid(0, row.amount_paid) : this.toMoney(row.amount_paid);
    const isWaived = row.status === fee_status_enum.WAIVED;
    const waivedAmount = isWaived ? this.waivedPortion({ amount: row.amount, amount_paid: row.amount_paid }) : 0;
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
      waived_amount: waivedAmount,
      // A waived head is never expected to be paid — no outstanding.
      outstanding: isWaived ? 0 : this.roundMoney(amount - amountPaid),
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

  /** Campus name → its code, the defaulters sheet's tab name ("GEJ"). */
  private async campusTabs(): Promise<Map<string, string>> {
    const campuses = await this.prisma.campuses.findMany({ select: { campus_name: true, campus_code: true } });
    return new Map(
      campuses
        .filter((c) => c.campus_code?.trim())
        .map((c) => [c.campus_name.trim(), this.sanitizeSheetName(c.campus_code!.trim())]),
    );
  }

  /** G.R. # as the defaulters sheet writes it: a number when it is all digits. */
  private defaulterGr(gr: unknown): string | number {
    const text = String(gr ?? '').trim();
    return /^\d+$/.test(text) ? Number(text) : text;
  }

  /** LEVEL as on the defaulters sheet: the class abbreviation and section, "VII A". */
  private defaulterLevel(className: unknown, section: unknown): string {
    const name = String(className ?? '').trim();
    return [DEFAULTER_LEVEL_ABBREVIATIONS[name] ?? name, String(section ?? '').trim()].filter(Boolean).join(' ');
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
    waived?: number;
  }) {
    const waived = this.roundMoney(totals.waived ?? 0);
    // Waived heads sit outside billed / to_be_billed and are netted out of
    // outstanding, so both identities carry a + waived term.
    const billedPlusToBeBilled = this.roundMoney(
      totals.billed + totals.to_be_billed + waived,
    );
    const paidPlusOutstanding = this.roundMoney(
      totals.amount_paid + totals.outstanding + waived,
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

  /**
   * TAFSD-268: Fee Heads / Deposits exports in the school's paper format (see
   * school-report-sheet.ts), one tab per campus when the rows carry a campus.
   * CSV stays the plain data table. Same rows and numbers as before — only the
   * layout changes, so the reconciliation invariants hold as they do on screen.
   */
  private async buildSchoolExportFile(
    sheetName: string,
    reportTitle: string,
    basename: string,
    columns: ExportColumn[],
    rows: Record<string, string | number>[],
    query: FinancialReportQueryDto & { format?: 'xlsx' | 'csv' | 'pdf'; paper?: SheetPaper },
    extraFilterLines: string[],
    generatedBy?: Pick<IJwtStaffPayload, 'sub' | 'username' | 'fullName'>,
    /** Excel / PDF sheets built by the caller (groups, per-campus columns); CSV still uses columns + rows. */
    prebuiltSheets?: SchoolSheet[],
  ): Promise<ExportFile> {
    if (query.format === 'csv') return this.buildExportFile(sheetName, basename, columns, rows, 'csv');
    // A PDF of tens of thousands of rows is hundreds of pages nobody prints —
    // and a long render. Excel has no such limit.
    if (query.format === 'pdf' && rows.length > PDF_EXPORT_ROW_CAP) {
      throw new BadRequestException(
        `PDF export is limited to ${PDF_EXPORT_ROW_CAP.toLocaleString()} rows (this has ${rows.length.toLocaleString()}). Narrow the filters or export Excel.`,
      );
    }

    const names = await this.loadDefaulterFilterNames(query);
    const classFiltered = Boolean(query.class_id?.length || query.segment_id?.length);
    const heading = defaulterSheetHeading(
      (query.class_id ?? []).map((id) => ({ class_id: id, class_name: names.classes.get(id) ?? String(id) })),
      classFiltered,
      query.to_date,
    );
    const filterLines = defaulterFilterLines(
      query,
      names,
      null,
      heading.classesLine != null,
      [],
      extraFilterLines,
    );

    // The school sheets are read by people: a stored instant (deposit_date)
    // prints as Pakistan time, "01-09-2026 10:28 AM", not raw ISO-in-UTC. The
    // CSV above keeps the machine-readable value.
    rows = rows.map((row) => {
      let out = row;
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'string' && ISO_INSTANT.test(value)) {
          if (out === row) out = { ...row };
          out[key] = this.formatPktDateTime(new Date(value));
        }
      }
      return out;
    });

    // Split by campus when the rows say which campus they are; the campus is
    // then the sheet's own line, so its column is dropped.
    const byCampus = columns.some((c) => c.key === 'campus');
    const sheetColumns: SchoolSheetColumn[] = columns
      .filter((c) => !byCampus || c.key !== 'campus')
      .map((c) => ({
        ...c,
        total: SCHOOL_SHEET_TOTAL_KEYS.has(c.key),
        money: SCHOOL_SHEET_TOTAL_KEYS.has(c.key) && !SCHOOL_SHEET_COUNT_KEYS.has(c.key),
      }));
    let sheets: SchoolSheet[];
    if (prebuiltSheets) {
      sheets = prebuiltSheets;
    } else if (byCampus) {
      const groups = new Map<string, Record<string, string | number>[]>();
      for (const row of rows) {
        const campus = String(row.campus ?? '').trim() || 'Unassigned';
        if (!groups.has(campus)) groups.set(campus, []);
        groups.get(campus)!.push(row);
      }
      sheets = [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([campus, campusRows]) => ({ tab: campus, campus: campusLine(campus), rows: campusRows }));
    } else {
      const campus = query.campus_id?.length
        ? [...names.campuses.values()].map((n) => campusLine(n)).join(', ')
        : 'ALL CAMPUSES';
      sheets = [{ tab: sheetName, campus, rows }];
    }

    const opts: SchoolSheetOptions = {
      reportTitle,
      heading,
      periodLine: periodLine(query.from_date, query.to_date),
      filterLines,
      exportDate: this.todayPkt(),
      // TAFSD-338/341: when and by whom, as on the defaulters sheet.
      generatedLine: `GENERATED ON ${this.formatPktDateTime(new Date())}${
        generatedBy ? ` BY ${await this.staffLabel(generatedBy)}` : ''
      }`,
      columns: sheetColumns,
    };

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'The American Foundation School';
    if (rows.length === 0) {
      writeEmptySheet(workbook, sheetName, 'Nothing matches the current filters.');
    } else {
      writeSchoolSheets(workbook, sheets, opts);
    }
    // TAFSD-425: the PDF is a print of this same workbook, as on the defaulters sheet.
    return schoolWorkbookFile(workbook, query, basename, reportTitle);
  }

  /** Fee Heads filters beyond the shared student ones, in words. */
  private feeHeadsFilterWords(query: ListFeeHeadsQueryDto): string[] {
    return query.status?.length ? [`FEE STATUS: ${query.status.map((s) => s.replace(/_/g, ' ')).join(', ')}`] : [];
  }

  /** Deposits filters beyond the shared student ones, in words. */
  private depositsFilterWords(query: ListDepositsQueryDto): string[] {
    const lines: string[] = [];
    if (query.payment_method?.length) lines.push(`PAYMENT METHOD: ${query.payment_method.join(', ').toUpperCase()}`);
    if (query.bank_name?.length) lines.push(`BANK: ${query.bank_name.join(', ').toUpperCase()}`);
    return lines;
  }

  /** "Aawaiz Ali (aawaiz)" — full name and username, either alone when the other is missing. */
  private async staffLabel(user: Pick<IJwtStaffPayload, 'sub' | 'username' | 'fullName'>): Promise<string> {
    const fullName =
      user.fullName?.trim() ||
      (await this.prisma.users.findUnique({ where: { id: user.sub }, select: { full_name: true } }))?.full_name?.trim();
    const username = user.username?.trim();
    if (fullName && username && fullName.toLowerCase() !== username.toLowerCase()) return `${fullName.toUpperCase()} (${username})`;
    return (fullName || username || 'UNKNOWN').toUpperCase();
  }

  /** "01-09-2026 10:28 AM" in Pakistan time. */
  private formatPktDateTime(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Karachi',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('day')}-${get('month')}-${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`;
  }

  /** Today as YYYY-MM-DD in Pakistan time, whatever the server's timezone. */
  private todayPkt(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
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

  /**
   * Money actually received against fee heads: the heads' amount_paid minus the
   * discount that was spent to settle them.
   *
   * When a discount closes a head (VouchersService.applyDiscountCreditInTx) it
   * is written into that head's amount_paid, so the head can show PAID — and
   * mirrored onto the discount row's own amount_paid as "consumed" (see
   * syncDiscountHeadsAmountPaidInTx). Summing heads' amount_paid alone therefore
   * counts the discount as cash: a 100,000 voucher with a 20,000 discount, paid
   * with 80,000, reported 100,000 paid and -20,000 outstanding. Subtracting the
   * discount rows' consumed amount gives the 80,000 back. Both sums must cover
   * the same filtered set of student_fees rows.
   */

  /**
   * The written-off part of WAIVED heads: whatever was not already paid. A
   * head waived after a part-payment keeps its cash (amount_paid) and waives
   * only the rest, so paid + waived = amount for every WAIVED head. Derived
   * from amount/amount_paid rather than waived_amount so a null or stale
   * waived_amount can never break the totals check.
   */
  private waivedPortion(sum: {
    amount: Prisma.Decimal | number | null;
    amount_paid?: Prisma.Decimal | number | null;
  }): number {
    return this.roundMoney(Math.max(0, this.toMoney(sum.amount) - this.toMoney(sum.amount_paid ?? 0)));
  }
  private netPaid(
    headsPaid: Prisma.Decimal | number | null | undefined,
    discountConsumed: Prisma.Decimal | number | null | undefined,
  ): number {
    return this.roundMoney(this.toMoney(headsPaid) - this.toMoney(discountConsumed));
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
