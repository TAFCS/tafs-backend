import { BadRequestException, Injectable } from '@nestjs/common';
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
import { StudentReportsService } from './student-reports.service';
import { sessionStartFor, type StrengthRow } from './strength.util';
import {
  DEPARTURE_TYPES,
  MAX_PERIODS,
  buildMovementGrid,
  eventInCell,
  eventsFor,
  periodsBetween,
  type DepartureType,
  type MovementEvent,
  type MovementOptions,
} from './movement.util';
import type {
  ExportMovementQueryDto,
  MovementCellQueryDto,
  MovementQueryDto,
} from './dto/movement-query.dto';

/** An admission's class is the first one on record, if recorded within this many days of the date of admission. */
const ADMISSION_CLASS_WINDOW_DAYS = 120;
const CELL_STUDENT_CAP = 1000;
const PDF_LIST_CAP = 2_000;

const TYPE_LABEL: Record<MovementEvent['type'], string> = {
  ADMITTED: 'Admitted',
  LEFT: 'Left',
  EXPELLED: 'Expelled',
  GRADUATED: 'Graduated',
};

const pktDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(d);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
/** "03-11-2026". */
const dmy = (date: string) => date.split('-').reverse().join('-');

/**
 * TAFSD-453: Admissions and Withdrawals (report C).
 *
 * Admissions: every student whose date of admission falls in the range,
 * whatever their status now. Their class is the first class on record when
 * that was recorded near the admission (so for anyone admitted since class
 * history began); older admissions show "Class not recorded".
 *
 * Withdrawals: each time a student was marked Left (and, on request,
 * Expelled or Graduated), on the date it was recorded, in the campus and
 * class they left from. A departure that was undone (reinstated) doesn't count.
 */
@Injectable()
export class MovementReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
    private readonly reports: StudentReportsService,
  ) {}

  async movement(query: MovementQueryDto, user: IJwtStaffPayload) {
    const { opts, events, notes } = await this.load(query, user);
    return {
      ...buildMovementGrid(events, opts),
      options: opts,
      departures: this.departures(query),
      notes,
    };
  }

  async cellStudents(query: MovementCellQueryDto, user: IJwtStaffPayload) {
    const { opts, events } = await this.load(query, user);
    const hits = events
      .filter((e) => eventInCell(e, query, opts))
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          (a.full_name ?? '').localeCompare(b.full_name ?? ''),
      );
    return {
      total: hits.length,
      truncated: hits.length > CELL_STUDENT_CAP,
      items: hits.slice(0, CELL_STUDENT_CAP).map((e) => ({
        ...e,
        type_label: TYPE_LABEL[e.type],
      })),
    };
  }

  async export(query: ExportMovementQueryDto, user: IJwtStaffPayload) {
    const { opts, events, notes, today } = await this.load(query, user);
    const list = query.part === 'list';
    const title = 'ADMISSIONS AND WITHDRAWALS REPORT';
    const basename = `admissions-withdrawals${list ? '-list' : ''}-${opts.from}-to-${opts.to}`;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'The American Foundation School';
    const counted = eventsFor(events, opts.measure);
    if (!counted.length) {
      writeEmptySheet(
        workbook,
        'Admissions and Withdrawals',
        'No admissions or withdrawals match the current filters.',
      );
      return schoolWorkbookFile(workbook, query, basename, title);
    }
    if (list && query.format === 'pdf' && counted.length > PDF_LIST_CAP)
      throw new BadRequestException(
        `PDF export lists at most ${PDF_LIST_CAP.toLocaleString()} students (this has ${counted.length.toLocaleString()}). Narrow the dates or filters, or export Excel.`,
      );

    const tabs = await this.reports.campusTabs();
    const sheets = list
      ? this.listSheets(counted, tabs)
      : this.summarySheets(buildMovementGrid(events, opts), opts, tabs);
    const classes = new Map<number, string>();
    for (const e of counted)
      if (e.class_id != null) classes.set(e.class_id, e.class_name ?? '');
    writeSchoolSheets(workbook, sheets, {
      reportTitle: title,
      heading: defaulterSheetHeading(
        [...classes].map(([class_id, class_name]) => ({
          class_id,
          class_name,
        })),
        Boolean(query.class_id?.length),
        today,
      ),
      periodLine: `FROM ${this.reports.longDate(opts.from)} TO ${this.reports.longDate(opts.to)}`,
      filterLines: [
        ...(await this.filterLines(query, opts, list)),
        ...notes.map((n) => n.toUpperCase()),
      ],
      exportDate: today,
      generatedLine: `GENERATED ON ${this.reports.pktDateTime(new Date())} BY ${this.reports.staffLabel(user)}`,
      columns: [],
    });
    return schoolWorkbookFile(
      workbook,
      query,
      basename,
      title,
      'Pick sessions instead of months, or a shorter date range.',
    );
  }

  // ─── Loading ────────────────────────────────────────────────────────────────

  private departures(query: MovementQueryDto): DepartureType[] {
    return query.departures?.length ? query.departures : ['LEFT'];
  }

  private async load(query: MovementQueryDto, user: IJwtStaffPayload) {
    const today = pktDate(new Date());
    const opts: MovementOptions = {
      measure: query.measure ?? 'both',
      rows: query.rows ?? 'class',
      period: query.period ?? 'month',
      from: query.from ?? sessionStartFor(today),
      to: query.to ?? today,
    };
    if (opts.from > opts.to)
      throw new BadRequestException('The start date is after the end date.');
    const periods = periodsBetween(opts.from, opts.to, opts.period).length;
    if (periods > MAX_PERIODS)
      throw new BadRequestException(
        `That is ${periods} ${opts.period === 'month' ? 'months' : 'sessions'}; the most one report shows is ${MAX_PERIODS}. Pick sessions instead of months, or a shorter date range.`,
      );

    // The caller's student scope, every status (a student who left still counts).
    const scope = await this.students.buildStudentsWhere(
      {} as GetStudentsDto,
      user,
    );
    const campusIds = query.campus_id?.length ? query.campus_id : null;
    const classIds = query.class_id?.length ? new Set(query.class_id) : null;
    const notes: string[] = [];

    const events: MovementEvent[] = [];
    if (opts.measure !== 'withdrawals') {
      const admitted = await this.admissions(scope, opts);
      events.push(...admitted);
      if (opts.rows === 'class' && admitted.some((e) => e.class_id == null))
        notes.push(
          'Class not recorded: admitted before class history was kept, so the class they joined is not known',
        );
    }
    if (opts.measure !== 'admissions') {
      const departures = this.departures(query);
      events.push(...(await this.withdrawals(scope, opts, departures)));
      const first = await this.prisma.student_progression_periods.aggregate({
        where: { change_type: { in: [...DEPARTURE_TYPES] } },
        _min: { valid_from: true },
      });
      const since = first._min.valid_from
        ? pktDate(first._min.valid_from)
        : null;
      if (since && opts.from < since)
        notes.push(
          `Leaving dates are recorded from ${dmy(since)}; students who left before that are counted on the day they were marked as left`,
        );
    }

    return {
      opts,
      today,
      notes,
      events: events.filter(
        (e) =>
          (!campusIds ||
            (e.campus_id != null && campusIds.includes(e.campus_id))) &&
          (!classIds || (e.class_id != null && classIds.has(e.class_id))),
      ),
    };
  }

  private async admissions(
    scope: object,
    o: MovementOptions,
  ): Promise<MovementEvent[]> {
    const rows = await this.prisma.students.findMany({
      where: {
        AND: [
          scope,
          {
            doa: {
              gte: new Date(`${o.from}T00:00:00Z`),
              lte: new Date(`${o.to}T00:00:00Z`),
            },
          },
        ],
      },
      select: {
        cc: true,
        full_name: true,
        gr_number: true,
        status: true,
        doa: true,
        campus_id: true,
        campuses: { select: { campus_name: true } },
        student_progression_periods: {
          orderBy: { valid_from: 'asc' },
          take: 1,
          select: {
            valid_from: true,
            campus_id: true,
            class_id: true,
            campuses: { select: { campus_name: true } },
            classes: { select: { description: true } },
            sections: { select: { description: true } },
          },
        },
      },
    });
    return rows.map((s) => {
      const date = ymd(s.doa!);
      const first = s.student_progression_periods[0];
      const known =
        first &&
        pktDate(first.valid_from) <= addDays(date, ADMISSION_CLASS_WINDOW_DAYS);
      return {
        type: 'ADMITTED' as const,
        date,
        cc: s.cc,
        full_name: s.full_name,
        gr_number: s.gr_number ?? null,
        campus_id: known ? first.campus_id : s.campus_id,
        campus:
          (known
            ? first.campuses?.campus_name
            : s.campuses?.campus_name
          )?.trim() ?? null,
        class_id: known ? first.class_id : null,
        class_name: known ? (first.classes?.description ?? null) : null,
        section: known ? (first.sections?.description ?? null) : null,
        status: String(s.status),
        note: null,
      };
    });
  }

  private async withdrawals(
    scope: object,
    o: MovementOptions,
    departures: DepartureType[],
  ): Promise<MovementEvent[]> {
    const periods = await this.prisma.student_progression_periods.findMany({
      where: {
        change_type: { in: departures },
        valid_from: {
          gte: new Date(`${o.from}T00:00:00+05:00`),
          lte: new Date(`${o.to}T23:59:59.999+05:00`),
        },
        students: { is: scope },
      },
      select: {
        student_cc: true,
        change_type: true,
        valid_from: true,
        valid_to: true,
        notes: true,
        campus_id: true,
        class_id: true,
        campuses: { select: { campus_name: true } },
        classes: { select: { description: true } },
        sections: { select: { description: true } },
        students: {
          select: { full_name: true, gr_number: true, status: true },
        },
      },
    });
    // A departure undone by a reinstatement (the next period) never happened.
    const reinstated = await this.prisma.student_progression_periods.findMany({
      where: {
        change_type: 'REINSTATED',
        student_cc: { in: [...new Set(periods.map((p) => p.student_cc))] },
      },
      select: { student_cc: true, valid_from: true },
    });
    const undone = new Set(
      reinstated.map((r) => `${r.student_cc}@${r.valid_from.getTime()}`),
    );
    return periods
      .filter(
        (p) =>
          !p.valid_to || !undone.has(`${p.student_cc}@${p.valid_to.getTime()}`),
      )
      .map((p) => ({
        type: p.change_type as DepartureType,
        date: pktDate(p.valid_from),
        cc: p.student_cc,
        full_name: p.students.full_name,
        gr_number: p.students.gr_number ?? null,
        campus_id: p.campus_id,
        campus: p.campuses?.campus_name?.trim() ?? null,
        class_id: p.class_id,
        class_name: p.classes?.description ?? null,
        section: p.sections?.description ?? null,
        status: String(p.students.status),
        note: p.notes?.trim() || null,
      }));
  }

  // ─── Excel / PDF ────────────────────────────────────────────────────────────

  private summarySheets(
    grid: ReturnType<typeof buildMovementGrid>,
    o: MovementOptions,
    tabs: Map<string, string>,
  ): SchoolSheet[] {
    const columns: SchoolSheetColumn[] = [
      ...grid.columns.map((c) => ({
        header: c.label.toUpperCase(),
        key: c.key,
        width: 9,
        total: true,
        group: c.group?.toUpperCase(),
      })),
      {
        header: o.measure === 'both' ? 'NET' : 'TOTAL',
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
    const campuses = grid.rows.filter((r) => r.level === 'campus');
    if (o.rows === 'campus')
      return [
        {
          tab: 'Admissions and Withdrawals',
          campus: 'ALL CAMPUSES',
          columns: [{ header: 'CAMPUS', key: 'label', width: 26 }, ...columns],
          rows: campuses.map(toRecord),
        },
      ];
    return campuses.map((c) => ({
      tab: tabs.get(c.label) ?? c.label.slice(0, 31),
      campus: campusLine(c.label),
      columns: [{ header: 'CLASS', key: 'label', width: 18 }, ...columns],
      rows: grid.rows
        .filter((r) => r.level === 'class' && r.campus_id === c.campus_id)
        .map(toRecord),
    }));
  }

  /** Per campus, class by class: every admission and withdrawal, by date. */
  private listSheets(
    events: MovementEvent[],
    tabs: Map<string, string>,
  ): SchoolSheet[] {
    const byCampus = new Map<string, MovementEvent[]>();
    for (const e of events) {
      const c = e.campus ?? 'No campus';
      byCampus.set(c, [...(byCampus.get(c) ?? []), e]);
    }
    const columns: SchoolSheetColumn[] = [
      { header: 'DATE', key: 'date', width: 12 },
      { header: 'ADMITTED / LEFT', key: 'type', width: 12 },
      { header: 'SECTION', key: 'section', width: 9 },
      { header: 'GR NO', key: 'gr', width: 10 },
      { header: 'CC', key: 'cc', width: 8 },
      { header: 'STUDENT NAME', key: 'name', width: 30 },
      { header: 'STATUS NOW', key: 'status', width: 12 },
      { header: 'REASON', key: 'note', width: 36 },
    ];
    return [...byCampus.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((campus) => {
        const list = byCampus
          .get(campus)!
          .sort(
            (a, b) =>
              (a.class_id ?? Number.MAX_SAFE_INTEGER) -
                (b.class_id ?? Number.MAX_SAFE_INTEGER) ||
              a.date.localeCompare(b.date) ||
              (a.full_name ?? '').localeCompare(b.full_name ?? ''),
          );
        const groups = new Map<string, SchoolSheetGroup>();
        for (const e of list) {
          const label = (e.class_name ?? 'Class not recorded').toUpperCase();
          const g = groups.get(label) ?? { label, rows: [] };
          g.rows.push({
            date: dmy(e.date),
            type: TYPE_LABEL[e.type].toUpperCase(),
            section: (e.section ?? '').toUpperCase(),
            gr: e.gr_number ?? '',
            cc: e.cc,
            name: (e.full_name ?? `CC ${e.cc}`).toUpperCase(),
            status: e.status.replace(/_/g, ' '),
            note: (e.note ?? '').toUpperCase(),
          });
          groups.set(label, g);
        }
        const out = [...groups.values()];
        return {
          tab: `${(tabs.get(campus) ?? campus).slice(0, 26)} LIST`,
          campus: campusLine(campus),
          columns,
          rows: out.flatMap((g) => g.rows),
          groups: out,
          rowNoun: ['STUDENT', 'STUDENTS'] as [string, string],
        };
      });
  }

  /** The filters and layout in words, under the title block. */
  private async filterLines(
    query: MovementQueryDto,
    o: MovementOptions,
    list: boolean,
  ): Promise<string[]> {
    const lines: string[] = [];
    if (query.campus_id?.length) {
      const rows = await this.prisma.campuses.findMany({
        where: { id: { in: query.campus_id } },
        select: { campus_name: true },
      });
      lines.push(
        `CAMPUS: ${rows.map((r) => r.campus_name.toUpperCase()).join(', ')}`,
      );
    }
    if (query.class_id?.length) {
      const rows = await this.prisma.classes.findMany({
        where: { id: { in: query.class_id } },
        select: { description: true },
      });
      lines.push(
        `CLASS: ${rows.map((r) => r.description.toUpperCase()).join(', ')}`,
      );
    }
    const left = this.departures(query)
      .map((d) => TYPE_LABEL[d].toUpperCase())
      .join(', ');
    lines.push(
      o.measure === 'admissions'
        ? 'ADMISSIONS (BY DATE OF ADMISSION)'
        : o.measure === 'withdrawals'
          ? `WITHDRAWALS: ${left}`
          : `ADMISSIONS AND WITHDRAWALS (${left}), WITH THE NET CHANGE`,
    );
    if (!list)
      lines.push(
        `BY ${o.rows === 'campus' ? 'CAMPUS' : 'CLASS'}, ${o.period === 'month' ? 'MONTH BY MONTH' : 'SESSION BY SESSION'}`,
      );
    else lines.push('STUDENT LIST');
    return lines;
  }
}
