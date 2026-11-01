import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../../prisma/prisma.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { StudentsService } from '../students/students.service';
import type { GetStudentsDto } from '../students/dto/get-students.dto';
import {
  campusLine,
  defaulterSheetHeading,
} from '../financial-reports/defaulter-sheet-heading';
import {
  writeSchoolSheets,
  type SchoolSheet,
  type SchoolSheetColumn,
  type SchoolSheetGroup,
} from '../financial-reports/school-report-sheet';
import {
  schoolWorkbookFile,
  writeEmptySheet,
} from '../financial-reports/school-sheet-common';
import {
  buildStrengthGrid,
  genderOf,
  inCell,
  normalizeStrengthOptions,
  sessionStartFor,
  splitValue,
  STRENGTH_SPLIT_LABELS,
  type StrengthContext,
  type StrengthGrid,
  type StrengthOptions,
  type StrengthRow,
  type StrengthStudent,
} from './strength.util';
import type {
  ExportStudentStrengthQueryDto,
  StudentStrengthCellQueryDto,
  StudentStrengthQueryDto,
} from './dto/student-strength-query.dto';

/** The most students one drill-down returns; the count above it is exact either way. */
const CELL_STUDENT_CAP = 1000;

/**
 * TAFSD-451: Student Reports, starting with Student Strength. Students are
 * picked exactly as the Student Directory picks them (its filters and the
 * caller's scope, via StudentsService.buildStudentsWhere), so the totals match
 * the directory for the same filters.
 */
@Injectable()
export class StudentReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
  ) {}

  async strength(query: StudentStrengthQueryDto, user: IJwtStaffPayload) {
    const { opts, ctx, roll } = await this.load(query, user);
    return {
      ...buildStrengthGrid(roll, opts, ctx),
      options: opts,
      as_of: ctx.today,
      session_start: ctx.sessionStart,
    };
  }

  async cellStudents(
    query: StudentStrengthCellQueryDto,
    user: IJwtStaffPayload,
  ) {
    const { opts, ctx, roll } = await this.load(query, user);
    const hits = roll.filter((s) =>
      inCell(s, { row: query.row, column: query.column }, opts, ctx),
    );
    hits.sort(
      (a, b) =>
        (a.campus ?? '').localeCompare(b.campus ?? '') ||
        (a.class_id ?? Number.MAX_SAFE_INTEGER) -
          (b.class_id ?? Number.MAX_SAFE_INTEGER) ||
        (a.section ?? '').localeCompare(b.section ?? '') ||
        (a.full_name ?? '').localeCompare(b.full_name ?? ''),
    );
    return {
      total: hits.length,
      truncated: hits.length > CELL_STUDENT_CAP,
      items: hits.slice(0, CELL_STUDENT_CAP).map((s) => ({
        cc: s.cc,
        full_name: s.full_name,
        gr_number: s.gr_number,
        campus: s.campus,
        class_name: s.class_name,
        section: s.section,
        house: s.house,
        gender: genderOf(s.gender).label,
        status: splitValue(s, 'status', ctx).label,
        age: splitValue(s, 'age', ctx).label,
      })),
    };
  }

  async exportStrength(
    query: ExportStudentStrengthQueryDto,
    user: IJwtStaffPayload,
  ) {
    const { opts, ctx, roll } = await this.load(query, user);
    const grid = buildStrengthGrid(roll, opts, ctx);
    const title = 'STUDENT STRENGTH REPORT';
    const basename = `student-strength-${ctx.today}`;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'The American Foundation School';

    if (grid.student_count === 0) {
      writeEmptySheet(
        workbook,
        'Student Strength',
        'No students match the current filters.',
      );
      return schoolWorkbookFile(workbook, query, basename, title);
    }

    const classNames = new Map<number, string>();
    for (const s of roll)
      if (s.class_id != null)
        classNames.set(s.class_id, s.class_name ?? String(s.class_id));
    const heading = defaulterSheetHeading(
      [...classNames.entries()].map(([class_id, class_name]) => ({
        class_id,
        class_name,
      })),
      Boolean(query.class_id?.length),
      ctx.today,
    );

    writeSchoolSheets(workbook, await this.strengthSheets(grid, opts), {
      reportTitle: title,
      heading,
      periodLine: `AS ON ${this.longDate(ctx.today)}`,
      filterLines: await this.filterLines(query, opts),
      exportDate: ctx.today,
      generatedLine: `GENERATED ON ${this.pktDateTime(new Date())} BY ${this.staffLabel(user)}`,
      columns: [],
    });
    return schoolWorkbookFile(
      workbook,
      query,
      basename,
      title,
      'Pick fewer splits, or export Excel.',
    );
  }

  // ─── Loading ────────────────────────────────────────────────────────────────

  private async load(query: StudentStrengthQueryDto, user: IJwtStaffPayload) {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
    }).format(new Date());
    const ctx: StrengthContext = {
      today,
      sessionStart: sessionStartFor(today),
    };
    const opts = normalizeStrengthOptions({
      rows: query.rows ?? 'class',
      split: query.split ?? null,
      split2: query.split2 ?? null,
    });

    const directoryQuery = {
      campus_id: query.campus_id,
      class_id: query.class_id,
      section_id: query.section_id,
      house_id: query.house_id,
      status: query.status,
    } as GetStudentsDto;
    const where = await this.students.buildStudentsWhere(directoryQuery, user);
    const rows = await this.prisma.students.findMany({
      where,
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
        campus_id: true,
        class_id: true,
        section_id: true,
        house_id: true,
        gender: true,
        status: true,
        dob: true,
        doa: true,
        campuses: { select: { campus_name: true } },
        classes: {
          select: {
            description: true,
            segment_id: true,
            segments: { select: { name: true, display_order: true } },
          },
        },
        sections: { select: { description: true } },
        houses: { select: { house_name: true } },
        student_admissions: {
          select: { discipline: true },
          orderBy: { application_date: 'desc' },
          take: 1,
        },
      },
    });

    let roll: StrengthStudent[] = rows.map((r) => ({
      cc: r.cc,
      full_name: r.full_name,
      gr_number: r.gr_number,
      campus_id: r.campus_id,
      campus: r.campuses?.campus_name ?? null,
      class_id: r.class_id,
      class_name: r.classes?.description ?? null,
      section_id: r.section_id,
      section: r.sections?.description ?? null,
      house_id: r.house_id,
      house: r.houses?.house_name ?? null,
      gender: r.gender,
      status: String(r.status),
      dob: r.dob,
      doa: r.doa,
      discipline: r.student_admissions[0]?.discipline ?? null,
      segment_id: r.classes?.segment_id ?? null,
      segment: r.classes?.segments?.name ?? null,
      segment_order: r.classes?.segments?.display_order ?? null,
    }));
    // Gender is free text in the table, so it is filtered after folding it.
    if (query.gender?.length) {
      const wanted = new Set<string>(query.gender);
      roll = roll.filter((s) => wanted.has(genderOf(s.gender).key));
    }
    return { opts, ctx, roll };
  }

  // ─── Excel ──────────────────────────────────────────────────────────────────

  /**
   * One sheet per campus (class rows, or class groups of section rows with a
   * SUBTOTAL each), or a single sheet of campus rows when only campuses are asked for.
   */
  private async strengthSheets(
    grid: StrengthGrid,
    opts: StrengthOptions,
  ): Promise<SchoolSheet[]> {
    const countColumns: SchoolSheetColumn[] = [
      ...grid.columns.map((c) => ({
        header: c.subtotal ? 'TOTAL' : c.label,
        key: c.key,
        width: 9,
        total: true,
        group: c.group?.toUpperCase(),
      })),
      {
        header: grid.columns.length ? 'GRAND TOTAL' : 'STUDENTS',
        key: 'total',
        width: 10,
        total: true,
      },
    ];
    const toRecord = (r: StrengthRow) => {
      const out: Record<string, string | number> = {
        label: r.label.toUpperCase(),
        total: r.total,
      };
      for (const c of grid.columns) out[c.key] = r.counts[c.key] ?? 0;
      return out;
    };

    if (opts.rows === 'campus') {
      return [
        {
          tab: 'Student Strength',
          campus: 'ALL CAMPUSES',
          columns: [
            { header: 'CAMPUS', key: 'label', width: 26 },
            ...countColumns,
          ],
          rows: grid.rows.filter((r) => r.level === 'campus').map(toRecord),
        },
      ];
    }

    const tabs = await this.campusTabs();
    const sheets: SchoolSheet[] = [];
    for (const campus of grid.rows.filter((r) => r.level === 'campus')) {
      const under = grid.rows.filter(
        (r) => r.campus_id === campus.campus_id && r.level !== 'campus',
      );
      const classes = under.filter((r) => r.level === 'class');
      const name = campus.label;
      const tab = tabs.get(name) ?? name.slice(0, 31);
      if (opts.rows === 'class') {
        sheets.push({
          tab,
          campus: campusLine(name),
          columns: [
            { header: 'CLASS', key: 'label', width: 18 },
            ...countColumns,
          ],
          rows: classes.map(toRecord),
        });
        continue;
      }
      const groups: SchoolSheetGroup[] = classes.map((k) => ({
        label: k.label.toUpperCase(),
        rows: under
          .filter((r) => r.level === 'section' && r.key.startsWith(`${k.key}|`))
          .map(toRecord),
      }));
      sheets.push({
        tab,
        campus: campusLine(name),
        columns: [
          { header: 'SECTION', key: 'label', width: 14 },
          ...countColumns,
        ],
        rows: groups.flatMap((g) => g.rows),
        groups,
        rowNoun: ['SECTION', 'SECTIONS'],
      });
    }
    return sheets;
  }

  /** The filters and the layout in words, under the title block. */
  private async filterLines(
    query: StudentStrengthQueryDto,
    opts: StrengthOptions,
  ): Promise<string[]> {
    const lines: string[] = [];
    const named = async (
      label: string,
      ids: number[] | undefined,
      load: (ids: number[]) => Promise<{ id: number; name: string | null }[]>,
    ) => {
      if (!ids?.length) return;
      const rows = await load(ids);
      const byId = new Map(rows.map((r) => [r.id, r.name ?? String(r.id)]));
      lines.push(
        `${label}: ${ids
          .map((id) => byId.get(id) ?? String(id))
          .join(', ')
          .toUpperCase()}`,
      );
    };
    await named('CAMPUS', query.campus_id, (ids) =>
      this.prisma.campuses
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, campus_name: true },
        })
        .then((r) => r.map((c) => ({ id: c.id, name: c.campus_name }))),
    );
    await named('CLASS', query.class_id, (ids) =>
      this.prisma.classes
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, description: true },
        })
        .then((r) => r.map((c) => ({ id: c.id, name: c.description }))),
    );
    await named('SECTION', query.section_id, (ids) =>
      this.prisma.sections
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, description: true },
        })
        .then((r) => r.map((c) => ({ id: c.id, name: c.description }))),
    );
    await named('HOUSE', query.house_id, (ids) =>
      this.prisma.houses
        .findMany({
          where: { id: { in: ids } },
          select: { id: true, house_name: true },
        })
        .then((r) => r.map((c) => ({ id: c.id, name: c.house_name }))),
    );
    if (query.status?.length)
      lines.push(
        `STATUS: ${query.status.map((s) => s.replace(/_/g, ' ')).join(', ')}`,
      );
    if (query.gender?.length)
      lines.push(
        `GENDER: ${query.gender.map((g) => (g === 'UNKNOWN' ? 'NOT SET' : g)).join(', ')}`,
      );
    if (lines.length === 0) lines.push('ALL STUDENTS ON ROLL');
    if (opts.split) {
      const parts = [opts.split, opts.split2]
        .filter(Boolean)
        .map((s) => STRENGTH_SPLIT_LABELS[s!].toUpperCase());
      lines.push(`BY ${parts.join(' × ')}`);
    }
    return lines;
  }

  private async campusTabs(): Promise<Map<string, string>> {
    const campuses = await this.prisma.campuses.findMany({
      select: { campus_name: true, campus_code: true },
    });
    return new Map(
      campuses
        .filter((c) => c.campus_code?.trim())
        .map((c) => [
          c.campus_name.trim(),
          c.campus_code
            .trim()
            .replace(/[\\/*?:[\]]/g, '')
            .slice(0, 31),
        ]),
    );
  }

  /** "1 NOVEMBER 2026". */
  private longDate(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', {
      month: 'long',
      timeZone: 'UTC',
    });
    return `${d} ${month} ${y}`.toUpperCase();
  }

  /** "01-11-2026 05:30 AM" in Pakistan time. */
  private pktDateTime(date: Date): string {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Karachi',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      })
        .formatToParts(date)
        .map((x) => [x.type, x.value]),
    );
    return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute} ${String(p.dayPeriod ?? '').toUpperCase()}`;
  }

  /** "AAWAIZ ALI (aawaiz.ali)". */
  private staffLabel(
    user: Pick<IJwtStaffPayload, 'username' | 'fullName'>,
  ): string {
    const name = user.fullName?.trim();
    return name ? `${name.toUpperCase()} (${user.username})` : user.username;
  }
}
