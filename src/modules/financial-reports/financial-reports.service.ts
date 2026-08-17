import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { Prisma, fee_status_enum } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { applyStudentScope } from '../../common/staff-scope';
import {
  getMonthYearLabel,
  termOfHead,
} from '../../common/utils/academic-labels';
import { createPaginationMeta } from '../../utils/serializer.util';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import type {
  ExportDepositsQueryDto,
  ExportFeeHeadsQueryDto,
  FinancialReportQueryDto,
  ListDepositsQueryDto,
  ListFeeHeadsQueryDto,
} from './dto/financial-report-query.dto';

const EXPORT_ROW_CAP = 25_000;
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
  students: {
    select: {
      cc: true,
      gr_number: true,
      full_name: true,
      class_id: true,
      campuses: { select: { campus_name: true } },
      classes: {
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

export type ExportFile = {
  buffer: Buffer;
  filename: string;
  contentType: string;
};

@Injectable()
export class FinancialReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async listFeeHeads(query: ListFeeHeadsQueryDto, user: IJwtStaffPayload) {
    this.assertDateRange(query);
    if ((query.view ?? 'heads') === 'student') {
      return this.listFeeHeadsByStudent(query, user);
    }

    const leaf = this.feeHeadsLeafWhere(query);
    const studentWhere = this.buildStudentWhere(query, user);
    const where = { ...leaf, students: studentWhere };
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 200);

    const [rows, totalsAgg, classTerms, studentCount] = await Promise.all([
      this.prisma.student_fees.findMany({
        where,
        select: FEE_HEAD_SELECT,
        orderBy: [{ fee_date: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.student_fees.aggregate({
        where,
        _sum: { amount: true, amount_paid: true },
        _count: true,
      }),
      this.loadClassTerms(),
      this.prisma.students.count({
        where: { ...studentWhere, student_fees: { some: leaf } },
      }),
    ]);

    const amount = this.toMoney(totalsAgg._sum.amount);
    const amountPaid = this.toMoney(totalsAgg._sum.amount_paid);

    return {
      view: 'heads' as const,
      items: rows.map((row) => this.mapFeeHead(row, classTerms)),
      pagination: createPaginationMeta(page, limit, totalsAgg._count),
      totals: {
        count: totalsAgg._count,
        student_count: studentCount,
        amount,
        amount_paid: amountPaid,
        outstanding: this.roundMoney(amount - amountPaid),
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

    const [groups, totalsAgg, studentCount] = await Promise.all([
      this.prisma.student_fees.groupBy({
        by: ['student_id'],
        where,
        _sum: { amount: true, amount_paid: true },
        _count: { _all: true },
        orderBy: { student_id: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.student_fees.aggregate({
        where,
        _sum: { amount: true, amount_paid: true },
        _count: true,
      }),
      this.prisma.students.count({
        where: { ...studentWhere, student_fees: { some: leaf } },
      }),
    ]);

    const studentIds = groups.map((g) => g.student_id);
    const students = studentIds.length
      ? await this.prisma.students.findMany({
          where: { cc: { in: studentIds } },
          select: {
            cc: true,
            gr_number: true,
            full_name: true,
            campuses: { select: { campus_name: true } },
            classes: { select: { description: true } },
            sections: { select: { description: true } },
          },
        })
      : [];
    const studentMap = new Map(students.map((s) => [s.cc, s]));

    const amount = this.toMoney(totalsAgg._sum.amount);
    const amountPaid = this.toMoney(totalsAgg._sum.amount_paid);

    return {
      view: 'student' as const,
      items: groups.map((group) => {
        const student = studentMap.get(group.student_id);
        const billed = this.toMoney(group._sum.amount);
        const paid = this.toMoney(group._sum.amount_paid);
        return {
          cc: group.student_id,
          gr_number: student?.gr_number ?? null,
          student_name: student?.full_name ?? '',
          campus: student?.campuses?.campus_name ?? '',
          class_name: student?.classes?.description ?? '',
          section: student?.sections?.description ?? '',
          head_count: group._count._all,
          amount: billed,
          amount_paid: paid,
          outstanding: this.roundMoney(billed - paid),
        };
      }),
      pagination: createPaginationMeta(page, limit, studentCount),
      totals: {
        count: totalsAgg._count,
        student_count: studentCount,
        amount,
        amount_paid: amountPaid,
        outstanding: this.roundMoney(amount - amountPaid),
      },
    };
  }

  async listDeposits(query: ListDepositsQueryDto, user: IJwtStaffPayload) {
    this.assertDateRange(query);
    const where = this.buildDepositsWhere(query, user);
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 200);

    const [rows, cash, byType] = await Promise.all([
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
    ]);

    return {
      items: rows.map((row) => this.mapDeposit(row)),
      pagination: createPaginationMeta(page, limit, cash._count),
      totals: this.buildDepositTotals(cash, byType),
    };
  }

  async exportFeeHeads(
    query: ExportFeeHeadsQueryDto,
    user: IJwtStaffPayload,
  ): Promise<ExportFile> {
    this.assertDateRange(query);
    if ((query.view ?? 'heads') === 'student') {
      return this.exportFeeHeadsByStudent(query, user);
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
      where,
      _sum: { amount: true, amount_paid: true },
      _count: { _all: true },
      orderBy: { student_id: 'asc' },
      take: EXPORT_ROW_CAP + 1,
    });
    this.assertExportCap(groups.length);

    const students = groups.length
      ? await this.prisma.students.findMany({
          where: { cc: { in: groups.map((g) => g.student_id) } },
          select: {
            cc: true,
            gr_number: true,
            full_name: true,
            campuses: { select: { campus_name: true } },
            classes: { select: { description: true } },
            sections: { select: { description: true } },
          },
        })
      : [];
    const studentMap = new Map(students.map((s) => [s.cc, s]));
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
      const billed = this.toMoney(group._sum.amount);
      const paid = this.toMoney(group._sum.amount_paid);
      return {
        cc: group.student_id,
        gr_number: student?.gr_number ?? '',
        student_name: student?.full_name ?? '',
        campus: student?.campuses?.campus_name ?? '',
        class_name: student?.classes?.description ?? '',
        section: student?.sections?.description ?? '',
        head_count: group._count._all,
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

  async listFilterOptions() {
    const segments = await this.prisma.segments.findMany({
      select: { id: true, code: true, name: true, display_order: true },
      orderBy: { display_order: 'asc' },
    });
    return { segments };
  }

  private buildStudentWhere(
    query: FinancialReportQueryDto,
    user: IJwtStaffPayload,
  ): Prisma.studentsWhereInput {
    const studentWhere: Prisma.studentsWhereInput = {
      deleted_at: null,
      ...(query.campus_id?.length && { campus_id: { in: query.campus_id } }),
      ...(query.class_id?.length && { class_id: { in: query.class_id } }),
      ...(query.section_id?.length && { section_id: { in: query.section_id } }),
      ...(query.segment_id?.length && {
        classes: { segment_id: { in: query.segment_id } },
      }),
    };
    return applyStudentScope(user, studentWhere, {
      campus_id: query.campus_id,
      class_id: query.class_id,
    });
  }

  private feeHeadsLeafWhere(
    query: ListFeeHeadsQueryDto,
  ): Prisma.student_feesWhereInput {
    return {
      is_discount: false,
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

  private mapFeeHead(
    row: Prisma.student_feesGetPayload<{ select: typeof FEE_HEAD_SELECT }>,
    classTerms: ReadonlyMap<number, number>,
  ) {
    const amount = this.toMoney(row.amount);
    const amountPaid = this.toMoney(row.amount_paid);
    const classId = row.students.class_id ?? row.students.classes?.id ?? null;
    const feeName = row.fee_types?.description ?? '';
    const feeType = [row.description_prefix, feeName].filter(Boolean).join(' ');

    return {
      id: row.id,
      cc: row.students.cc,
      gr_number: row.students.gr_number,
      student_name: row.students.full_name,
      campus: row.students.campuses?.campus_name ?? '',
      class_name: row.students.classes?.description ?? '',
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
    const allocDecimal = byType.reduce(
      (sum, row) => sum.plus(row._sum.amount ?? 0),
      new Prisma.Decimal(0),
    );

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
