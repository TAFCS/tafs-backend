import { BadRequestException, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../../prisma/prisma.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { StudentsService } from '../students/students.service';
import type { GetStudentsDto } from '../students/dto/get-students.dto';
import {
  BENEFIT_SELECT,
  STUDENT_BENEFITS,
  benefitActive,
  benefitFields,
  type StudentBenefitKey,
} from '../students/student-benefits';

/** YYYY-MM-DD plus n days. */
const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
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
  isLinked,
  type CategoryExportPart,
  matchesCategoryFilters,
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
import type { ExportStudentCategoriesQueryDto } from './dto/student-strength-query.dto';
import type {
  ExportStudentStrengthQueryDto,
  StudentStrengthCellQueryDto,
  StudentStrengthQueryDto,
} from './dto/student-strength-query.dto';

/** TAFSD-455: the Special Categories PDF lists every student; same cap as the fee reports' PDFs. */
const PDF_LIST_STUDENT_CAP = 2_000;

/** The most students one drill-down returns; the count above it is exact either way. */
const CELL_STUDENT_CAP = 1000;

/** TAFSD-452: another student of the same family. */
export interface SiblingRef {
  cc: number;
  full_name: string | null;
  status: string;
  class_name: string | null;
  section: string | null;
  campus: string | null;
  /** TAFSD-456: for the linked-siblings list. */
  gr_number: string | null;
  class_id: number | null;
  benefits: BenefitDetail[];
}

/** TAFSD-455: a benefit switched on, including one past its end date (active = false). */
export interface BenefitDetail {
  key: StudentBenefitKey;
  label: string;
  reason: string | null;
  until: string | null;
  remind_from: string | null;
  active: boolean;
}

const day = (d: Date | null | undefined) =>
  d ? d.toISOString().slice(0, 10) : null;

/** Every benefit switched on for a student row (selected with BENEFIT_SELECT). */
function benefitDetails(
  row: Record<string, any>,
  today: string,
): BenefitDetail[] {
  return STUDENT_BENEFITS.filter((b) => row[b.flag]).map((b) => {
    const f = benefitFields(b);
    return {
      key: b.key,
      label: b.label,
      reason: (row[f.reason] as string | null) ?? null,
      until: day(row[f.until]),
      remind_from: day(row[f.remindFrom]),
      active: benefitActive(row, b, today),
    };
  });
}

/** TAFSD-452: what the drill-down and the list sheet show beyond the grid's fields. */
export interface CategoryDetail {
  /** Enrolled siblings: these make the student linked. */
  siblings: SiblingRef[];
  /** Siblings with any other status (left, graduated, …): listed, never linking. */
  other_siblings: SiblingRef[];
  /** TAFSD-455: every benefit switched on, including ones past their end date (active = false). */
  benefits: BenefitDetail[];
}

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
    const { opts, ctx, roll, details } = await this.load(query, user);
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
        ...details.get(s.cc)!,
      })),
    };
  }

  exportStrength(query: ExportStudentStrengthQueryDto, user: IJwtStaffPayload) {
    return this.exportReport(query, user, 'strength');
  }

  /** TAFSD-452: the same grid, then one list sheet per campus naming each student's siblings. */
  exportCategories(
    query: ExportStudentCategoriesQueryDto,
    user: IJwtStaffPayload,
  ) {
    return this.exportReport(query, user, 'categories');
  }

  private async exportReport(
    query: ExportStudentStrengthQueryDto,
    user: IJwtStaffPayload,
    kind: 'strength' | 'categories',
  ) {
    const { opts, ctx, roll, details } = await this.load(query, user);
    const grid = buildStrengthGrid(roll, opts, ctx);
    const title =
      kind === 'strength'
        ? 'STUDENT STRENGTH REPORT'
        : 'SPECIAL CATEGORIES REPORT';
    const tabName =
      kind === 'strength' ? 'Student Strength' : 'Special Categories';
    // TAFSD-456: the Special Categories download in parts; omitted = summary and full list.
    const part =
      kind === 'categories'
        ? (query as ExportStudentCategoriesQueryDto).part
        : undefined;
    const PART_NAMES: Record<CategoryExportPart, string> = {
      summary: 'summary',
      list: 'students',
      linked: 'linked-siblings',
      single: 'single-children',
    };
    const basename = `${kind === 'strength' ? 'student-strength' : 'special-categories'}${part ? `-${PART_NAMES[part]}` : ''}-${ctx.today}`;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'The American Foundation School';

    if (grid.student_count === 0) {
      writeEmptySheet(
        workbook,
        tabName,
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

    const tabs = await this.campusTabs();
    const listPart = part === 'linked' || part === 'single' ? part : 'list';
    const sheets =
      part && part !== 'summary'
        ? []
        : this.strengthSheets(grid, opts, tabs, tabName);
    if (kind === 'categories' && part !== 'summary') {
      // The list sheets name every student; the fee reports cap PDF at the same size.
      if (query.format === 'pdf' && roll.length > PDF_LIST_STUDENT_CAP)
        throw new BadRequestException(
          `PDF export lists at most ${PDF_LIST_STUDENT_CAP.toLocaleString()} students (this has ${roll.length.toLocaleString()}). Narrow the filters, for example to one category, or export Excel.`,
        );
      sheets.push(
        ...this.categoryListSheets(roll, details, tabs, ctx.today, listPart),
      );
      if (!sheets.length) {
        writeEmptySheet(
          workbook,
          tabName,
          part === 'linked'
            ? 'No students with siblings in school match the current filters.'
            : 'No single children match the current filters.',
        );
        return schoolWorkbookFile(workbook, query, basename, title);
      }
    }
    writeSchoolSheets(workbook, sheets, {
      reportTitle: title,
      heading,
      periodLine: `AS ON ${this.longDate(ctx.today)}`,
      filterLines: [
        // A list has no grid, so no "BY …" layout line.
        ...(await this.filterLines(
          query,
          part && part !== 'summary'
            ? { ...opts, split: null, split2: null }
            : opts,
        )),
        ...(part === 'linked'
          ? [
              'STUDENTS WITH SIBLINGS IN SCHOOL (STUDENT IN BOLD, SIBLINGS BELOW)',
            ]
          : part === 'single'
            ? ['SINGLE CHILDREN (NO SIBLINGS IN SCHOOL)']
            : part === 'list'
              ? ['STUDENT LIST']
              : []),
      ],
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
      category: query.category,
      siblings: query.siblings,
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
        family_id: true,
        ...BENEFIT_SELECT,
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

    const families = await this.familyMembers(rows, today);
    const details = new Map<number, CategoryDetail>();
    for (const r of rows) {
      const others = (
        r.family_id != null ? (families.get(r.family_id) ?? []) : []
      ).filter((m) => m.cc !== r.cc);
      details.set(r.cc, {
        siblings: others.filter((m) => m.status === 'ENROLLED'),
        other_siblings: others.filter((m) => m.status !== 'ENROLLED'),
        benefits: benefitDetails(r, today),
      });
    }

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
      enrolled_siblings: details.get(r.cc)!.siblings.length,
      benefits: details
        .get(r.cc)!
        .benefits.filter((b) => b.active)
        .map((b) => ({ key: b.key, until: b.until })),
    }));
    // Gender is free text in the table, so it is filtered after folding it.
    if (query.gender?.length) {
      const wanted = new Set<string>(query.gender);
      roll = roll.filter((s) => wanted.has(genderOf(s.gender).key));
    }
    const endingBy =
      query.ending_within_days != null
        ? addDays(today, query.ending_within_days)
        : undefined;
    if (query.siblings?.length || query.category?.length || endingBy)
      roll = roll.filter((s) =>
        matchesCategoryFilters(s, query.siblings, query.category, endingBy),
      );
    return { opts, ctx, roll, details };
  }

  /**
   * TAFSD-452: every student of the loaded students' families, across the whole
   * school, not just the filtered or scoped ones: a sibling in another campus
   * still makes a student linked.
   */
  private async familyMembers(
    rows: { family_id: number | null }[],
    today: string,
  ): Promise<Map<number, SiblingRef[]>> {
    const ids = [
      ...new Set(rows.map((r) => r.family_id).filter((id) => id != null)),
    ];
    const out = new Map<number, SiblingRef[]>();
    if (!ids.length) return out;
    const members = await this.prisma.students.findMany({
      where: { family_id: { in: ids }, deleted_at: null },
      select: {
        cc: true,
        family_id: true,
        full_name: true,
        gr_number: true,
        class_id: true,
        status: true,
        ...BENEFIT_SELECT,
        classes: { select: { description: true } },
        sections: { select: { description: true } },
        campuses: { select: { campus_name: true } },
      },
      orderBy: [{ class_id: 'desc' }, { full_name: 'asc' }],
    });
    for (const m of members) {
      const list = out.get(m.family_id!) ?? [];
      list.push({
        cc: m.cc,
        full_name: m.full_name,
        status: String(m.status),
        class_name: m.classes?.description ?? null,
        section: m.sections?.description ?? null,
        campus: m.campuses?.campus_name ?? null,
        gr_number: m.gr_number ?? null,
        class_id: m.class_id ?? null,
        benefits: benefitDetails(m, today),
      });
      out.set(m.family_id!, list);
    }
    return out;
  }

  // ─── Excel ──────────────────────────────────────────────────────────────────

  /**
   * One sheet per campus (class rows, or class groups of section rows with a
   * SUBTOTAL each), or a single sheet of campus rows when only campuses are asked for.
   */
  private strengthSheets(
    grid: StrengthGrid,
    opts: StrengthOptions,
    tabs: Map<string, string>,
    tabName: string,
  ): SchoolSheet[] {
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
          tab: tabName,
          campus: 'ALL CAMPUSES',
          columns: [
            { header: 'CAMPUS', key: 'label', width: 26 },
            ...countColumns,
          ],
          rows: grid.rows.filter((r) => r.level === 'campus').map(toRecord),
        },
      ];
    }

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

  /**
   * TAFSD-452/456: per campus, students in class groups (with the group's
   * count). `list`: every student with their Enrolled siblings, siblings who
   * aren't (left, graduated, …) and their special category. `single`: only
   * students with no Enrolled sibling. `linked`: only students with one, each
   * in bold with their siblings in the rows under it.
   */
  private categoryListSheets(
    roll: StrengthStudent[],
    details: Map<number, CategoryDetail>,
    tabs: Map<string, string>,
    today: string,
    part: 'list' | 'linked' | 'single' = 'list',
  ): SchoolSheet[] {
    const where = (m: { class_name: string | null; section: string | null }) =>
      [m.class_name, m.section].filter(Boolean).join(' ').toUpperCase();
    const sib = (m: SiblingRef) => {
      const w = where(m);
      return `${(m.full_name ?? `CC ${m.cc}`).toUpperCase()}${w ? ` (${w})` : ''}`;
    };
    const other = (m: SiblingRef) =>
      `${(m.full_name ?? `CC ${m.cc}`).toUpperCase()} (${m.status.replace(/_/g, ' ')})`;
    const benefits = (list: BenefitDetail[]) =>
      list
        .map((b) => {
          if (!b.until) return b.label.toUpperCase();
          const [y, mo, dd] = b.until.split('-');
          return `${b.label.toUpperCase()} ${b.until < today ? 'ENDED' : 'UNTIL'} ${dd}-${mo}-${y}`;
        })
        .join('; ');
    const name = (m: { cc: number; full_name: string | null }) =>
      (m.full_name ?? `CC ${m.cc}`).toUpperCase();

    const students =
      part === 'list'
        ? roll
        : roll.filter((s) => isLinked(s) === (part === 'linked'));
    const byCampus = new Map<string, StrengthStudent[]>();
    for (const s of students) {
      const c = s.campus?.trim() || 'No campus';
      byCampus.set(c, [...(byCampus.get(c) ?? []), s]);
    }

    const columns: SchoolSheetColumn[] =
      part === 'linked'
        ? [
            { header: 'CLASS', key: 'cls', width: 14 },
            { header: 'GR NO', key: 'gr', width: 10 },
            { header: 'CC', key: 'cc', width: 8 },
            { header: 'STUDENT / SIBLING', key: 'name', width: 32 },
            { header: 'CAMPUS', key: 'campus', width: 14 },
            { header: 'STATUS', key: 'status', width: 12 },
            { header: 'SPECIAL CATEGORY', key: 'category', width: 40 },
          ]
        : part === 'single'
          ? [
              { header: 'SECTION', key: 'section', width: 10 },
              { header: 'GR NO', key: 'gr', width: 10 },
              { header: 'CC', key: 'cc', width: 8 },
              { header: 'STUDENT NAME', key: 'name', width: 30 },
              { header: 'SIBLINGS NOT ENROLLED', key: 'others', width: 34 },
              { header: 'SPECIAL CATEGORY', key: 'category', width: 40 },
            ]
          : [
              { header: 'SECTION', key: 'section', width: 10 },
              { header: 'GR NO', key: 'gr', width: 10 },
              { header: 'CC', key: 'cc', width: 8 },
              { header: 'STUDENT NAME', key: 'name', width: 28 },
              { header: 'HAS SIBLINGS', key: 'linked', width: 10 },
              { header: 'SIBLINGS IN SCHOOL', key: 'siblings', width: 40 },
              { header: 'SIBLINGS NOT ENROLLED', key: 'others', width: 32 },
              { header: 'SPECIAL CATEGORY', key: 'category', width: 40 },
            ];
    const tabSuffix =
      part === 'linked' ? 'LINKED' : part === 'single' ? 'SINGLE' : 'LIST';

    const sheets: SchoolSheet[] = [];
    for (const campus of [...byCampus.keys()].sort((a, b) =>
      a.localeCompare(b),
    )) {
      const list = byCampus
        .get(campus)!
        .sort(
          (a, b) =>
            (a.class_id ?? Number.MAX_SAFE_INTEGER) -
              (b.class_id ?? Number.MAX_SAFE_INTEGER) ||
            (a.section ?? '').localeCompare(b.section ?? '') ||
            (a.full_name ?? '').localeCompare(b.full_name ?? ''),
        );
      const groups = new Map<
        string,
        { rows: Array<Record<string, string | number>>; count: number }
      >();
      for (const s of list) {
        const d = details.get(s.cc)!;
        const label = (s.class_name?.trim() || 'No class').toUpperCase();
        const g = groups.get(label) ?? { rows: [], count: 0 };
        g.count++;
        if (part === 'linked') {
          // The student in bold, numbered; their siblings under it, unnumbered.
          g.rows.push({
            __sno: g.count,
            __bold: 1,
            cls: where(s),
            gr: s.gr_number ?? '',
            cc: s.cc,
            name: name(s),
            campus: (tabs.get(s.campus ?? '') ?? s.campus ?? '').toUpperCase(),
            status: s.status.replace(/_/g, ' '),
            category: benefits(d.benefits),
          });
          for (const m of [...d.siblings, ...d.other_siblings])
            g.rows.push({
              __sno: '',
              cls: where(m),
              gr: m.gr_number ?? '',
              cc: m.cc,
              name: name(m),
              campus: (
                tabs.get(m.campus ?? '') ??
                m.campus ??
                ''
              ).toUpperCase(),
              status: m.status.replace(/_/g, ' '),
              category: benefits(m.benefits),
            });
        } else {
          g.rows.push({
            section: (s.section ?? '').toUpperCase(),
            gr: s.gr_number ?? '',
            cc: s.cc,
            name: name(s),
            linked: isLinked(s) ? 'YES' : 'NO',
            siblings: d.siblings.map(sib).join(', '),
            others: d.other_siblings.map(other).join(', '),
            category: benefits(d.benefits),
          });
        }
        groups.set(label, g);
      }
      const out = [...groups.entries()].map(([label, g]) => ({
        label,
        rows: g.rows,
        count: g.count,
      }));
      const code = tabs.get(campus) ?? campus;
      sheets.push({
        tab: `${code.slice(0, 24)} ${tabSuffix}`,
        campus: campusLine(campus),
        columns,
        rows: out.flatMap((g) => g.rows),
        groups: out,
        rowNoun: ['STUDENT', 'STUDENTS'],
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
    if (query.siblings?.length)
      lines.push(
        `SIBLINGS: ${query.siblings
          .map((v) =>
            v === 'LINKED' ? 'HAS SIBLINGS IN SCHOOL' : 'NO SIBLINGS IN SCHOOL',
          )
          .join(', ')}`,
      );
    if (query.category?.length)
      lines.push(
        `CATEGORY: ${query.category
          .map((v) =>
            v === 'NONE'
              ? 'NEITHER'
              : STUDENT_BENEFITS.find((b) => b.key === v)!.label.toUpperCase(),
          )
          .join(', ')}`,
      );
    if (query.ending_within_days != null)
      lines.push(`ENDING WITHIN ${query.ending_within_days} DAYS`);
    if (lines.length === 0) lines.push('ALL STUDENTS ON ROLL');
    if (opts.split) {
      const parts = [opts.split, opts.split2]
        .filter(Boolean)
        .map((s) => STRENGTH_SPLIT_LABELS[s!].toUpperCase());
      lines.push(`BY ${parts.join(' × ')}`);
    }
    return lines;
  }

  async campusTabs(): Promise<Map<string, string>> {
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
  longDate(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number);
    const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', {
      month: 'long',
      timeZone: 'UTC',
    });
    return `${d} ${month} ${y}`.toUpperCase();
  }

  /** "01-11-2026 05:30 AM" in Pakistan time. */
  pktDateTime(date: Date): string {
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
  staffLabel(user: Pick<IJwtStaffPayload, 'username' | 'fullName'>): string {
    const name = user.fullName?.trim();
    return name ? `${name.toUpperCase()} (${user.username})` : user.username;
  }
}
