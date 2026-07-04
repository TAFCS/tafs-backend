import { Injectable, Logger } from '@nestjs/common';
import {
  AttendanceSource,
  DevicePersonType,
  Prisma,
  RollRecordStatus,
  ScanDirection,
  StaffAttendanceStatus,
  zk_attendance_scans,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { CalendarDayResolverService } from '../hr/calendar/calendar-day-resolver.service';
import { AttendancePolicyResolverService } from './attendance-policy-resolver.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { resolveTemplate, isTemplateDisabled } from '../../utils/notification-templates.util';

const DEDUP_WINDOW_MS = 2 * 60 * 1000; // accidental double-tap / device retry window
const LIVE_THRESHOLD_MS = 10 * 60 * 1000; // scans older than this on arrival are backfill, not live

interface ParsedAttLogRow {
  pin: string;
  scanTime: Date;
  status?: string;
  verify?: string;
  workCode?: string;
}

export interface DaySegment {
  checkInAt: Date | null;
  checkOutAt: Date | null;
  lastScanAt: Date | null;
  scanCount: number;
}

export type NotificationSkipReason =
  | 'unmapped_pin'
  | 'duplicate_scan'
  | 'not_live'
  | 'no_direction'
  | 'no_family_id';

export interface ScanProcessResult {
  scanId: number;
  notified: boolean;
  skipReason?: NotificationSkipReason;
}

export interface ProcessPushOptions {
  /** Simulate-scan and other deliberate test paths — always notify when possible. */
  forceNotify?: boolean;
}

/**
 * Turns raw ZKTeco ADMS pushes (already logged verbatim to zk_push_logs) into
 * attendance records. Staff don't select Check-In/Check-Out/Break on the device —
 * they just scan — so direction (IN/OUT) is inferred purely from scan order per
 * person per day: 1st scan = IN (check-in), 2nd = OUT, 3rd = IN, etc. The first IN
 * is check-in, the most recent OUT is the running check-out time, and any IN/OUT
 * pairs in between are breaks (fully derived, nothing stored separately).
 */
@Injectable()
export class ZkAttendanceProcessorService {
  private readonly logger = new Logger(ZkAttendanceProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fcmService: FcmService,
    private readonly calendarResolver: CalendarDayResolverService,
    private readonly policyResolver: AttendancePolicyResolverService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async processPush(
    payload: {
      sn: string;
      query: Record<string, string>;
      body: string;
      pushLogId: number | null;
    },
    options?: ProcessPushOptions,
  ): Promise<ScanProcessResult[]> {
    const table = (payload.query['table'] ?? payload.query['Table'] ?? '').toUpperCase();

    if (table === 'ATTLOG') {
      return this.processAttLog(payload.sn, payload.body, payload.pushLogId, options);
    }
    if (table === 'OPERLOG') {
      await this.processOperLog(payload.sn, payload.body);
    }
    // Other table types (USERINFO, BIOPHOTO, etc.) are already captured raw in
    // zk_push_logs by ZkPushService — no further action needed.
    return [];
  }

  private async processAttLog(
    sn: string,
    body: string,
    pushLogId: number | null,
    options?: ProcessPushOptions,
  ): Promise<ScanProcessResult[]> {
    const rows = this.parseAttLogLines(body);
    const now = new Date();
    const results: ScanProcessResult[] = [];

    for (const row of rows) {
      try {
        const result = await this.processOneScan(
          {
            sn,
            pin: row.pin,
            scanTime: row.scanTime,
            status: row.status,
            verify: row.verify,
            workCode: row.workCode,
            pushLogId,
            now,
          },
          options,
        );
        if (result) results.push(result);
      } catch (err: any) {
        this.logger.error(`Failed to process scan (pin=${row.pin}, sn=${sn}): ${err.message}`);
      }
    }

    return results;
  }

  private parseAttLogLines(body: string): ParsedAttLogRow[] {
    const rows: ParsedAttLogRow[] = [];
    for (const line of body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)) {
      const [pin, dateTimeStr, status, verify, workCode] = line.split('\t');
      const scanTime = this.parseDeviceDateTime(dateTimeStr);
      if (pin && scanTime) {
        rows.push({ pin, scanTime, status, verify, workCode });
      }
    }
    return rows;
  }

  // "YYYY-MM-DD HH:MM:SS" device-local wall clock -> stored as a naive timestamp
  // (Date.UTC preserves the literal numbers regardless of server process TZ),
  // matching the convention used for employee_profiles.reporting_time/leaving_time.
  private parseDeviceDateTime(s: string): Date | null {
    const m = s?.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, se] = m;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
  }

  // OPERLOG enrollment lines look like: "USER PIN=16\tName=Ali Khan\tPri=0\t..."
  // Used only to suggest names to admins mapping unmapped PINs.
  private async processOperLog(sn: string, body: string): Promise<void> {
    const rows = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((line) => {
        const fields: Record<string, string> = {};
        for (const token of line.split(/\s+/)) {
          const eq = token.indexOf('=');
          if (eq > 0) fields[token.slice(0, eq)] = token.slice(eq + 1);
        }
        return { pin: fields['PIN'], name: fields['Name'] };
      })
      .filter((r) => !!r.pin);

    for (const row of rows) {
      try {
        await this.prisma.zk_pin_name_hints.upsert({
          where: { device_sn_device_pin: { device_sn: sn, device_pin: row.pin } },
          create: { device_sn: sn, device_pin: row.pin, suggested_name: row.name ?? null },
          update: { suggested_name: row.name ?? undefined },
        });
      } catch (err: any) {
        this.logger.error(`Failed to upsert PIN name hint (pin=${row.pin}, sn=${sn}): ${err.message}`);
      }
    }
  }

  private startOfUTCDay(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  // Converts a real instant to its Asia/Karachi wall-clock components expressed
  // as a Date.UTC value — the same naive-local convention used for scanTime.
  private toNaiveLocalMs(d: Date): number {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Karachi',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .reduce<Record<string, string>>((acc, part) => { acc[part.type] = part.value; return acc; }, {});
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  }

  private scanDirectionFromSegment(seg: DaySegment): ScanDirection | null {
    if (seg.scanCount <= 0) return null;
    return seg.scanCount % 2 === 0 ? ScanDirection.OUT : ScanDirection.IN;
  }

  private async processOneScan(
    input: {
      sn: string;
      pin: string;
      scanTime: Date;
      status?: string;
      verify?: string;
      workCode?: string;
      pushLogId: number | null;
      now: Date;
    },
    options?: ProcessPushOptions,
  ): Promise<ScanProcessResult | undefined> {
    const attendanceDate = this.startOfUTCDay(input.scanTime);

    const mapping = await this.prisma.device_user_mappings.findUnique({
      where: { device_sn_device_pin: { device_sn: input.sn, device_pin: input.pin } },
    });

    const personType = mapping?.is_active ? mapping.person_type : null;
    const employeeId = mapping?.is_active ? mapping.employee_id : null;
    const studentCc = mapping?.is_active ? mapping.student_cc : null;

    // Soft dedup: a scan within DEDUP_WINDOW_MS of this person's last accepted scan
    // (any device) doesn't toggle the sequence — accidental double-tap / retry.
    let isDuplicate = false;
    if (personType) {
      const last = await this.prisma.zk_attendance_scans.findFirst({
        where: {
          person_type: personType,
          ...(personType === 'STAFF' ? { employee_id: employeeId } : { student_cc: studentCc }),
          is_duplicate: false,
        },
        orderBy: { scan_time: 'desc' },
      });
      if (last && Math.abs(input.scanTime.getTime() - last.scan_time.getTime()) < DEDUP_WINDOW_MS) {
        isDuplicate = true;
      }
    }

    // scanTime is a naive-local (PKT) timestamp stored via Date.UTC, so compare
    // against now expressed in the same naive-local space, not real UTC.
    const isLive = Math.abs(input.scanTime.getTime() - this.toNaiveLocalMs(input.now)) < LIVE_THRESHOLD_MS;

    let scanRow: zk_attendance_scans;
    try {
      scanRow = await this.prisma.zk_attendance_scans.create({
        data: {
          device_sn: input.sn,
          device_pin: input.pin,
          person_type: personType ?? undefined,
          employee_id: employeeId ?? undefined,
          student_cc: studentCc ?? undefined,
          scan_time: input.scanTime,
          attendance_date: attendanceDate,
          verify_mode: input.verify,
          device_status: input.status,
          work_code: input.workCode,
          is_duplicate: isDuplicate,
          is_live: isLive,
          zk_push_log_id: input.pushLogId ?? undefined,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return; // exact duplicate (device_sn, device_pin, scan_time) already processed
      }
      throw err;
    }

    if (!personType || isDuplicate) return; // unmapped PIN or accidental double-scan: stop here

    const seg = await this.recomputeDaySequence(personType, employeeId, studentCc, attendanceDate);

    if (personType === DevicePersonType.STAFF) {
      await this.upsertStaffDaily(employeeId!, attendanceDate, seg);
      return undefined;
    }

    const scanDirection = this.scanDirectionFromSegment(seg);
    await this.upsertStudentDaily(studentCc!, attendanceDate, seg);

    const shouldNotify = (isLive || options?.forceNotify) && scanDirection;
    if (!shouldNotify) {
      const skipReason: NotificationSkipReason = !scanDirection
        ? 'no_direction'
        : 'not_live';
      this.logger.debug(
        `Notification skipped for student ${studentCc} (scan ${scanRow.id}): ${skipReason}`,
      );
      return { scanId: scanRow.id, notified: false, skipReason };
    }

    const notified = await this.sendScanNotification(studentCc!, scanRow, scanDirection);
    if (notified) {
      await this.prisma.zk_attendance_scans.update({
        where: { id: scanRow.id },
        data: { notified_at: new Date() },
      });
      return { scanId: scanRow.id, notified: true };
    }

    this.logger.warn(
      `Notification skipped for student ${studentCc} (scan ${scanRow.id}): no_family_id`,
    );
    return { scanId: scanRow.id, notified: false, skipReason: 'no_family_id' };
  }

  // Reassigns sequence_no/direction for every scan of this person+day, ordered by
  // scan_time: even index = IN, odd index = OUT. Index 0 = check-in. The most
  // recent OUT = current check-out time (earlier OUTs become "break-out" once a
  // later IN/OUT pair exists). Daily scan counts are tiny, so recomputing the
  // whole day is cheap and self-heals if scans arrive out of order.
  async recomputeDaySequence(
    personType: DevicePersonType,
    employeeId: number | null,
    studentCc: number | null,
    attendanceDate: Date,
  ): Promise<DaySegment> {
    const scans = await this.prisma.zk_attendance_scans.findMany({
      where: {
        person_type: personType,
        ...(personType === 'STAFF' ? { employee_id: employeeId } : { student_cc: studentCc }),
        attendance_date: attendanceDate,
        is_duplicate: false,
      },
      orderBy: { scan_time: 'asc' },
    });

    if (scans.length === 0) {
      return { checkInAt: null, checkOutAt: null, lastScanAt: null, scanCount: 0 };
    }

    const updates = scans
      .map((s, idx) => {
        const direction: ScanDirection = idx % 2 === 0 ? ScanDirection.IN : ScanDirection.OUT;
        return { id: s.id, sequence_no: idx, direction, changed: s.sequence_no !== idx || s.direction !== direction };
      })
      .filter((u) => u.changed);

    if (updates.length > 0) {
      await this.prisma.$transaction(
        updates.map((u) =>
          this.prisma.zk_attendance_scans.update({
            where: { id: u.id },
            data: { sequence_no: u.sequence_no, direction: u.direction },
          }),
        ),
      );
    }

    const checkInAt = scans[0].scan_time;
    const lastScanAt = scans[scans.length - 1].scan_time;
    const lastOutIdx = scans.length % 2 === 0 ? scans.length - 1 : scans.length - 2;
    const checkOutAt = lastOutIdx >= 0 ? scans[lastOutIdx].scan_time : null;

    return { checkInAt, checkOutAt, lastScanAt, scanCount: scans.length };
  }

  // Never overwrites a row whose source = MANUAL — admins marking e.g. EXCUSED
  // for approved leave won't get silently flipped back by a later scan.
  async upsertStaffDaily(employeeId: number, date: Date, seg: DaySegment): Promise<void> {
    if (!seg.checkInAt) return;

    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { campus_id: true },
    });
    if (!employee?.campus_id) return;

    const resolved = await this.calendarResolver.resolveStaffDay(employeeId, employee.campus_id, date);
    if (!resolved.isWorkingDay) return;

    const existing = await this.prisma.attendance_staff_daily.findUnique({
      where: { employee_id_date: { employee_id: employeeId, date } },
    });
    if (
      existing?.source === AttendanceSource.MANUAL ||
      existing?.source === AttendanceSource.SYSTEM ||
      existing?.source === AttendanceSource.LEAVE
    ) return;

    const policy = await this.policyResolver.resolveStaffCheckInPolicy(
      employeeId,
      employee.campus_id,
      date,
    );
    const status = this.computeStaffStatus(seg.checkInAt, policy.expectedCheckIn, policy.graceMinutes);

    await this.prisma.attendance_staff_daily.upsert({
      where: { employee_id_date: { employee_id: employeeId, date } },
      create: {
        employee_id: employeeId,
        campus_id: employee.campus_id,
        date,
        status,
        source: AttendanceSource.BIOMETRIC,
        check_in_at: seg.checkInAt,
        check_out_at: seg.checkOutAt,
        last_scan_at: seg.lastScanAt,
      },
      update: {
        status,
        source: AttendanceSource.BIOMETRIC,
        check_in_at: seg.checkInAt,
        check_out_at: seg.checkOutAt,
        last_scan_at: seg.lastScanAt,
      },
    });

    this.auditLogs.log({
      entity_type: 'STAFF_ATTENDANCE',
      entity_id: String(employeeId),
      action: 'CREATED',
      section: 'attendance',
      note: `Biometric scan — ${status} on ${date.toISOString().slice(0, 10)}`,
      changed_by: 'zk-device',
    });
  }

  private computeStaffStatus(
    checkInAt: Date,
    reportingTime: Date | null,
    lateRelaxationMinutes: number | null,
  ): StaffAttendanceStatus {
    if (!reportingTime) return StaffAttendanceStatus.PRESENT;
    const reportingMinutes = reportingTime.getUTCHours() * 60 + reportingTime.getUTCMinutes();
    const checkInMinutes = checkInAt.getUTCHours() * 60 + checkInAt.getUTCMinutes();
    const relaxation = lateRelaxationMinutes ?? 0;
    return checkInMinutes > reportingMinutes + relaxation ? StaffAttendanceStatus.LATE : StaffAttendanceStatus.PRESENT;
  }

  // Returns this scan's own direction (for the live-notification decision), or
  // null if nothing should be notified (manual override or no campus on record).
  async upsertStudentDaily(studentCc: number, date: Date, seg: DaySegment): Promise<ScanDirection | null> {
    if (!seg.lastScanAt) return null;

    const student = await this.prisma.students.findUnique({
      where: { cc: studentCc },
      select: { campus_id: true, class_id: true, section_id: true },
    });
    if (!student?.campus_id) return null;

    const resolved = await this.calendarResolver.resolveStudentDay(
      student.campus_id,
      student.class_id,
      student.section_id,
      date,
    );
    if (!resolved.isWorkingDay) return null;

    const existing = await this.prisma.attendance_student_daily.findUnique({
      where: { student_cc_date: { student_cc: studentCc, date } },
    });
    if (existing?.source === AttendanceSource.MANUAL || existing?.source === AttendanceSource.SYSTEM) return null;

    const policy = await this.policyResolver.resolveStudentCheckInPolicy(
      student.class_id,
      student.campus_id,
      date,
    );
    const status = this.computeStudentStatus(seg.checkInAt!, policy.expectedCheckIn, policy.graceMinutes);

    await this.prisma.attendance_student_daily.upsert({
      where: { student_cc_date: { student_cc: studentCc, date } },
      create: {
        student_cc: studentCc,
        campus_id: student.campus_id,
        date,
        status,
        source: AttendanceSource.BIOMETRIC,
        check_in_at: seg.checkInAt,
        check_out_at: seg.checkOutAt,
        last_scan_at: seg.lastScanAt,
      },
      update: {
        status,
        source: AttendanceSource.BIOMETRIC,
        check_in_at: seg.checkInAt,
        check_out_at: seg.checkOutAt,
        last_scan_at: seg.lastScanAt,
      },
    });

    this.auditLogs.log({
      entity_type: 'STUDENT_ATTENDANCE',
      entity_id: String(studentCc),
      action: 'CREATED',
      section: 'attendance',
      note: `Biometric scan — ${status} on ${date.toISOString().slice(0, 10)}`,
      changed_by: 'zk-device',
      student_id: studentCc,
    });

    return seg.scanCount % 2 === 0 ? ScanDirection.OUT : ScanDirection.IN;
  }

  private computeStudentStatus(
    checkInAt: Date,
    expectedCheckIn: Date | null,
    graceMinutes: number,
  ): RollRecordStatus {
    if (!expectedCheckIn) return RollRecordStatus.PRESENT;
    const expectedMinutes = expectedCheckIn.getUTCHours() * 60 + expectedCheckIn.getUTCMinutes();
    const checkInMinutes = checkInAt.getUTCHours() * 60 + checkInAt.getUTCMinutes();
    return checkInMinutes > expectedMinutes + graceMinutes ? RollRecordStatus.LATE : RollRecordStatus.PRESENT;
  }

  private async sendScanNotification(
    studentCc: number,
    scanRow: { scan_time: Date },
    direction: ScanDirection,
  ): Promise<boolean> {
    const student = await this.prisma.students.findUnique({
      where: { cc: studentCc },
      select: { full_name: true, family_id: true },
    });
    if (!student?.family_id) return false;

    const time = scanRow.scan_time.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    });

    const attendanceDate = new Date(scanRow.scan_time);
    attendanceDate.setUTCHours(0, 0, 0, 0);

    const dailyRow = await this.prisma.attendance_student_daily.findUnique({
      where: {
        student_cc_date: {
          student_cc: studentCc,
          date: attendanceDate,
        },
      },
    });

    const isLate = direction === ScanDirection.IN && dailyRow?.status === RollRecordStatus.LATE;
    const vars = { student_name: student.full_name, time };

    let title: string;
    let body: string;
    let templateTitleKey: string;
    if (direction === ScanDirection.IN && isLate) {
      templateTitleKey = 'notif_attend_late_title';
    } else if (direction === ScanDirection.IN) {
      templateTitleKey = 'notif_attend_arrived_title';
    } else {
      templateTitleKey = 'notif_attend_left_title';
    }

    if (await isTemplateDisabled(this.prisma, templateTitleKey)) return false;

    if (direction === ScanDirection.IN && isLate) {
      title = await resolveTemplate(this.prisma, 'notif_attend_late_title', 'Arrived Late', vars);
      body = await resolveTemplate(this.prisma, 'notif_attend_late_body', '{student_name} has arrived late at TAFS at {time}', vars);
    } else if (direction === ScanDirection.IN) {
      title = await resolveTemplate(this.prisma, 'notif_attend_arrived_title', 'Arrived at School', vars);
      body = await resolveTemplate(this.prisma, 'notif_attend_arrived_body', '{student_name} has arrived at TAFS at {time}', vars);
    } else {
      title = await resolveTemplate(this.prisma, 'notif_attend_left_title', 'Left School', vars);
      body = await resolveTemplate(this.prisma, 'notif_attend_left_body', '{student_name} has left TAFS at {time}', vars);
    }

    await this.prisma.attendance_notifications.create({
      data: {
        family_id: student.family_id,
        student_cc: studentCc,
        direction,
        scan_time: scanRow.scan_time,
        title,
        body,
      },
    });

    await this.fcmService.sendToFamily(student.family_id, title, body, {
      type: 'biometric_attendance',
      student_cc: String(studentCc),
      direction,
      scan_time: scanRow.scan_time.toISOString(),
    });

    return true;
  }
}
