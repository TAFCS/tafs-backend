import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma, StaffRole, student_status } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ScopeService } from '../../../common/scope/scope.service';
import { isPendingMigrationError } from '../../../utils/pending-migration.util';
import { AccessService } from '../../access/access.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { StaffNotificationsService } from '../../staff-notifications/staff-notifications.service';
import {
  NON_ENROLLED_ACTION,
  NON_ENROLLED_ALERT_KIND,
  NON_ENROLLED_ALERTS_ACTION_ID,
  NON_ENROLLED_REPORT_PATH,
  NON_ENROLLED_TILE_ID,
  STATUS_LABEL,
  isNonEnrolledFlagStatus,
} from './non-enrolled-scan.constants';

/** The scan as the processor just stored it. */
export type ScanToCheck = {
  id: number;
  student_cc: number;
  device_sn: string;
  device_pin: string;
  /** Naive Pakistan time stored in the UTC fields, as on zk_attendance_scans. */
  scan_time: Date;
  attendance_date: Date;
};

export type FlagOutcome = 'enrolled' | 'flagged' | 'already_flagged' | 'table_missing' | 'failed';

export type NonEnrolledReportQuery = {
  from?: string;
  to?: string;
  campus_ids?: number[];
  /** Segments of the student's class. Empty means every segment you can see. */
  segment_ids?: number[];
  q?: string;
};

export type NonEnrolledReportRow = {
  date: string;
  student_cc: number;
  full_name: string | null;
  gr_number: string | null;
  class_name: string | null;
  /** Status when they scanned. */
  status: student_status;
  /** Their status now, which may differ if they were brought back since. */
  current_status: student_status | null;
  left_on: string | null;
  campus_id: number | null;
  campus_name: string | null;
  /** The segment of the student's class (Early Years, Junior, ...). */
  segment_id: number | null;
  segment_name: string | null;
  devices: { sn: string; pin: string }[];
  first_scan: string;
  last_scan: string;
  scans: number;
};

/** Students and check-in days per segment, for the report's breakdown. */
export type NonEnrolledSegmentCount = {
  segment_id: number | null;
  segment_name: string | null;
  students: number;
  days: number;
};

const MAX_RANGE_DAYS = 366;
const PKT_OFFSET_MS = 5 * 3600_000;

const pad = (n: number) => String(n).padStart(2, '0');
/** YYYY-MM-DD of a value whose UTC fields hold the wall date (DATE columns, naive PKT scan times). */
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
/** HH:mm of a naive PKT scan time. */
const hhmm = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
/** A real instant (left_at, written by now()) as its Pakistan date. */
const pktYmd = (d: Date) => ymd(new Date(d.getTime() + PKT_OFFSET_MS));

/** Today in Pakistan as a DATE value (midnight UTC of the PKT date). */
export function todayPktDate(now = new Date()): Date {
  const pkt = new Date(now.getTime() + PKT_OFFSET_MS);
  return new Date(Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), pkt.getUTCDate()));
}

function parseDate(value: string | undefined, label: string): Date | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException(`${label} must be YYYY-MM-DD`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${label} is not a date`);
  return d;
}

/** Name, C.C. or G.R. as people type them; empty means no narrowing. */
export function studentSearchWhere(q: string | undefined): Prisma.studentsWhereInput {
  const term = q?.trim();
  if (!term) return {};
  const or: Prisma.studentsWhereInput[] = [
    { full_name: { contains: term, mode: 'insensitive' } },
    { gr_number: { contains: term, mode: 'insensitive' } },
  ];
  if (/^\d{1,9}$/.test(term)) or.push({ cc: Number(term) });
  return { OR: or };
}

/** One entry per segment present in the rows, in segment order; no segment last. */
export function countBySegment(rows: NonEnrolledReportRow[]): NonEnrolledSegmentCount[] {
  const map = new Map<number | null, { name: string | null; students: Set<number>; days: number }>();
  for (const r of rows) {
    const entry = map.get(r.segment_id) ?? { name: r.segment_name, students: new Set<number>(), days: 0 };
    entry.students.add(r.student_cc);
    entry.days += 1;
    map.set(r.segment_id, entry);
  }
  return [...map.entries()]
    .map(([segment_id, e]) => ({ segment_id, segment_name: e.name, students: e.students.size, days: e.days }))
    .sort((a, b) => (a.segment_id == null ? 1 : b.segment_id == null ? -1 : (a.segment_name ?? '').localeCompare(b.segment_name ?? '')));
}

export function alertText(input: {
  fullName: string | null;
  cc: number;
  status: student_status;
  leftOn: string | null;
  campusName: string | null;
  time: string;
}) {
  const who = `${input.fullName ?? 'A student'} (C.C. ${input.cc})`;
  const status = (STATUS_LABEL[input.status] ?? input.status).toLowerCase();
  const since = input.leftOn ? ` since ${input.leftOn}` : '';
  const where = input.campusName ? ` at ${input.campusName}` : '';
  return {
    title: 'Student not enrolled checked in',
    body: `${who} is marked ${status}${since} but scanned in${where} at ${input.time}.`,
  };
}

/**
 * TAFSD-556: a student who has left, been expelled or graduated can still scan
 * in on a biometric device, because their device mapping stays active. The
 * scan is processed exactly as before (the day is marked, the parent is told);
 * this service only records a flag beside it, alerts the people who asked to
 * be told, and serves the report.
 *
 * Everything the scan processor calls here is best-effort and never throws: a
 * failure to flag must not stop a scan being processed.
 */
@Injectable()
export class NonEnrolledScansService {
  private readonly logger = new Logger(NonEnrolledScansService.name);
  private warnedTableMissing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly access: AccessService,
    private readonly notifications: StaffNotificationsService,
  ) {}

  /**
   * Flags the scan when its student is not enrolled. Never throws. Safe to call
   * twice for the same scan: the second call finds the flag already there and
   * sends nothing.
   */
  async flagScan(scan: ScanToCheck, now = new Date()): Promise<FlagOutcome> {
    try {
      const student = await this.prisma.students.findUnique({
        where: { cc: scan.student_cc },
        select: { status: true, campus_id: true, full_name: true, campuses: { select: { campus_name: true } } },
      });
      if (!student || !isNonEnrolledFlagStatus(student.status)) return 'enrolled';

      const period = await this.prisma.student_progression_periods.findFirst({
        where: { student_cc: scan.student_cc, valid_to: null, change_type: student.status },
        orderBy: { valid_from: 'desc' },
        select: { valid_from: true },
      });
      const leftAt = period?.valid_from ?? null;

      const created = await this.prisma.attendance_non_enrolled_scans.createMany({
        data: [
          {
            scan_id: scan.id,
            student_cc: scan.student_cc,
            student_status: student.status,
            left_at: leftAt,
            campus_id: student.campus_id,
            device_sn: scan.device_sn,
            device_pin: scan.device_pin,
            scan_time: scan.scan_time,
            attendance_date: scan.attendance_date,
          },
        ],
        skipDuplicates: true,
      });
      if (created.count === 0) return 'already_flagged';

      // Alert only for today's scans, so a device catching up after downtime
      // doesn't send alerts about days already gone; those are in the report.
      if (scan.attendance_date.getTime() === todayPktDate(now).getTime() && (await this.claimAlert(scan, now))) {
        await this.sendAlerts(scan, {
          fullName: student.full_name,
          status: student.status,
          leftOn: leftAt ? pktYmd(leftAt) : null,
          campusName: student.campuses?.campus_name ?? null,
        });
      }
      return 'flagged';
    } catch (err) {
      if (isPendingMigrationError(err)) {
        if (!this.warnedTableMissing) {
          this.warnedTableMissing = true;
          this.logger.warn('attendance_non_enrolled_scans does not exist yet; non-enrolled check-ins are not being flagged until its migration is applied.');
        }
        return 'table_missing';
      }
      this.logger.error(`Could not flag scan ${scan.id} (CC ${scan.student_cc}): ${(err as Error).message}`);
      return 'failed';
    }
  }

  /**
   * Marks this scan's flag as the one that alerted for the student's day. Only
   * one flag per (student, day) can hold alerted_at (partial unique index), so
   * of two scans racing, one wins and the other sends nothing.
   */
  private async claimAlert(scan: ScanToCheck, now: Date): Promise<boolean> {
    const already = await this.prisma.attendance_non_enrolled_scans.count({
      where: { student_cc: scan.student_cc, attendance_date: scan.attendance_date, alerted_at: { not: null } },
    });
    if (already) return false;
    try {
      const claimed = await this.prisma.attendance_non_enrolled_scans.updateMany({
        where: { scan_id: scan.id, alerted_at: null },
        data: { alerted_at: now },
      });
      return claimed.count === 1;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
      throw err;
    }
  }

  /**
   * Who gets these alerts:
   * - every active SUPER_ADMIN, unless they have an explicit deny on the
   *   `alerts` action (the one way a super admin opts out);
   * - everyone else with an explicit tick on `alerts`, for the person or
   *   through a pack, still holding it after denials and deactivation.
   * Each alert is then limited to recipients whose scope covers the student
   * (campus, segment, class, section), see sendAlerts.
   */
  async alertRecipients(): Promise<string[]> {
    const [direct, viaPack, superAdmins, denied] = await Promise.all([
      this.prisma.user_tile_action_grants.findMany({
        where: { tile_id: NON_ENROLLED_TILE_ID, action_id: NON_ENROLLED_ALERTS_ACTION_ID, allow: true },
        select: { user_id: true },
      }),
      this.prisma.user_access_packs.findMany({
        where: {
          pack: { tile_actions: { some: { tile_id: NON_ENROLLED_TILE_ID, action_id: NON_ENROLLED_ALERTS_ACTION_ID } } },
        },
        select: { user_id: true },
      }),
      this.prisma.users.findMany({ where: { role: StaffRole.SUPER_ADMIN, is_active: true }, select: { id: true } }),
      this.prisma.user_tile_action_grants.findMany({
        where: { tile_id: NON_ENROLLED_TILE_ID, action_id: NON_ENROLLED_ALERTS_ACTION_ID, allow: false },
        select: { user_id: true },
      }),
    ]);
    const optedOut = new Set(denied.map((r) => r.user_id));
    const holders: string[] = superAdmins.map((u) => u.id).filter((id) => !optedOut.has(id));
    const already = new Set(holders);
    const candidates = [...new Set([...direct, ...viaPack].map((r) => r.user_id))].filter((id) => !already.has(id));
    for (const userId of candidates) {
      const session = await this.access.resolveLiveSession(userId);
      if (session?.isActive && session.actionIds.includes(NON_ENROLLED_ACTION.alerts)) holders.push(userId);
    }
    return holders;
  }

  /** One alert to each holder who can see the student (their campus and other scope). */
  private async sendAlerts(
    scan: ScanToCheck,
    info: { fullName: string | null; status: student_status; leftOn: string | null; campusName: string | null },
  ) {
    const recipients = await this.alertRecipients();
    if (recipients.length === 0) return;
    const date = ymd(scan.attendance_date);
    const link = `${NON_ENROLLED_REPORT_PATH}?from=${date}&to=${date}`;
    const text = alertText({ ...info, cc: scan.student_cc, time: hhmm(scan.scan_time) });
    for (const userId of recipients) {
      if (!(await this.canSeeStudent(userId, scan.student_cc))) continue;
      await this.notifications.notify(userId, {
        kind: NON_ENROLLED_ALERT_KIND,
        ...text,
        link,
        entityType: 'STUDENT',
        entityId: String(scan.student_cc),
        pushData: { link },
      });
    }
  }

  private async canSeeStudent(userId: string, cc: number): Promise<boolean> {
    const user = await this.prisma.users.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user) return false;
    if (user.role === StaffRole.SUPER_ADMIN) return true;
    const scope = await this.scope.resolveEffective(userId);
    const scopeWhere = this.scope.whereForStudents({ role: user.role, scope });
    const visible = await this.prisma.students.count({ where: { AND: [scopeWhere, { cc }] } });
    return visible > 0;
  }

  // ── Report ──────────────────────────────────────────────────────────────

  /**
   * One row per student per day in the range, within the caller's scope. Until
   * the migration is applied the report is empty and says so.
   */
  async report(query: NonEnrolledReportQuery, user: IJwtStaffPayload) {
    const today = todayPktDate();
    const from = parseDate(query.from, 'from') ?? today;
    const to = parseDate(query.to, 'to') ?? from;
    if (to < from) throw new BadRequestException('to must be on or after from');
    if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
      throw new BadRequestException(`Pick a range of at most ${MAX_RANGE_DAYS} days`);
    }
    const campusIds = query.campus_ids?.length ? query.campus_ids : undefined;
    const segmentIds = query.segment_ids?.length ? query.segment_ids : undefined;
    // Scope (campus, segment, class, section) always applies; the segment
    // filter can only narrow it further.
    const scopeWhere = this.scope.whereForStudents(user);
    const studentWhere: Prisma.studentsWhereInput = {
      AND: [
        scopeWhere,
        studentSearchWhere(query.q),
        ...(segmentIds ? [{ classes: { is: { segment_id: { in: segmentIds } } } }] : []),
      ],
    };

    let flags;
    try {
      flags = await this.prisma.attendance_non_enrolled_scans.findMany({
        where: {
          attendance_date: { gte: from, lte: to },
          ...(campusIds ? { campus_id: { in: campusIds } } : {}),
          students: { is: studentWhere },
        },
        orderBy: [{ attendance_date: 'desc' }, { scan_time: 'asc' }],
        select: {
          student_cc: true,
          student_status: true,
          left_at: true,
          campus_id: true,
          device_sn: true,
          device_pin: true,
          scan_time: true,
          attendance_date: true,
          campuses: { select: { campus_name: true } },
          students: {
            select: {
              full_name: true,
              gr_number: true,
              status: true,
              classes: { select: { class_code: true, segment_id: true, segments: { select: { name: true } } } },
            },
          },
        },
      });
    } catch (err) {
      if (isPendingMigrationError(err)) {
        return {
          from: ymd(from),
          to: ymd(to),
          rows: [] as NonEnrolledReportRow[],
          by_segment: [] as NonEnrolledSegmentCount[],
          pending_migration: true,
        };
      }
      throw err;
    }

    const byDay = new Map<string, NonEnrolledReportRow>();
    for (const f of flags) {
      const date = ymd(f.attendance_date);
      const key = `${date}:${f.student_cc}`;
      const time = hhmm(f.scan_time);
      const device = { sn: f.device_sn, pin: f.device_pin };
      const row = byDay.get(key);
      if (!row) {
        byDay.set(key, {
          date,
          student_cc: f.student_cc,
          full_name: f.students?.full_name ?? null,
          gr_number: f.students?.gr_number ?? null,
          class_name: f.students?.classes?.class_code ?? null,
          status: f.student_status,
          current_status: f.students?.status ?? null,
          left_on: f.left_at ? pktYmd(f.left_at) : null,
          campus_id: f.campus_id,
          campus_name: f.campuses?.campus_name ?? null,
          segment_id: f.students?.classes?.segment_id ?? null,
          segment_name: f.students?.classes?.segments?.name ?? null,
          devices: [device],
          first_scan: time,
          last_scan: time,
          scans: 1,
        });
        continue;
      }
      // Rows arrive in scan order within a day, so the latest one wins.
      row.last_scan = time;
      row.status = f.student_status;
      row.scans += 1;
      if (!row.devices.some((d) => d.sn === device.sn && d.pin === device.pin)) row.devices.push(device);
    }
    const rows = [...byDay.values()];
    return { from: ymd(from), to: ymd(to), rows, by_segment: countBySegment(rows), pending_migration: false };
  }

  async exportExcel(query: NonEnrolledReportQuery, user: IJwtStaffPayload): Promise<Buffer> {
    const { from, to, rows } = await this.report(query, user);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Not enrolled check-ins');
    ws.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'C.C.', key: 'student_cc', width: 8 },
      { header: 'G.R.', key: 'gr_number', width: 10 },
      { header: 'Student', key: 'full_name', width: 30 },
      { header: 'Class', key: 'class_name', width: 14 },
      { header: 'Segment', key: 'segment_name', width: 16 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Left on', key: 'left_on', width: 12 },
      { header: 'Status now', key: 'current_status', width: 12 },
      { header: 'Campus', key: 'campus_name', width: 24 },
      { header: 'Device (serial / PIN)', key: 'devices', width: 34 },
      { header: 'First scan', key: 'first_scan', width: 11 },
      { header: 'Last scan', key: 'last_scan', width: 11 },
      { header: 'Scans', key: 'scans', width: 7 },
    ];
    for (const r of rows) {
      ws.addRow({
        ...r,
        status: STATUS_LABEL[r.status] ?? r.status,
        current_status: r.current_status ? STATUS_LABEL[r.current_status] ?? r.current_status : '',
        left_on: r.left_on ?? '',
        segment_name: r.segment_name ?? '',
        devices: r.devices.map((d) => `${d.sn} / ${d.pin}`).join(', '),
      });
    }
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const note = ws.addRow({ date: `${rows.length} check-in day(s), ${from} to ${to}` });
    note.font = { italic: true };
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
