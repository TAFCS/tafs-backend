import { timingsForDate } from '../hr/employees/employee-day-timings.util';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AttendanceObjectionStatus,
  AttendanceSource,
  StaffAttendanceStatus,
  StaffRole,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { StaffNotificationsService } from '../staff-notifications/staff-notifications.service';
import { clause, renderNotification } from '../../utils/notification-templates.util';
import { EmployeeProfileResolverService } from '../hr/employee-profile-resolver.service';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import { ScopeService } from '../../common/scope/scope.service';
import {
  CreateAttendanceObjectionDto,
  ListAttendanceObjectionsQueryDto,
  ReviewAttendanceObjectionDto,
} from './dto/attendance-objections.dto';
import { assertMayChangeEmployee } from '../../common/auth/super-admin';
import { EmployeeExpectedTimesService } from '../timetables/employee-expected-times.service';
import { isLateCheckIn } from './manual-late.util';

@Injectable()
export class AttendanceObjectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly employeeResolver: EmployeeProfileResolverService,
    private readonly fcmService: FcmService,
    private readonly auditLogs: AuditLogsService,
    private readonly scope: ScopeService,
    private readonly expectedTimes: EmployeeExpectedTimesService,
    private readonly staffNotifications: StaffNotificationsService,
  ) {}

  private parseDate(dateStr: string): Date {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private assertCampusAccess(user: IJwtStaffPayload, campusId: number) {
    this.scope.assertCampus(user, campusId);
  }

  async create(userId: string, dto: CreateAttendanceObjectionDto) {
    const employee = await this.employeeResolver.requireByUserId(userId);
    const attendanceDate = this.parseDate(dto.attendance_date);
    const claimedTime = new Date(dto.claimed_time);
    if (Number.isNaN(claimedTime.getTime())) {
      throw new BadRequestException('Invalid claimed_time');
    }

    // TAFSD-413: an overridden day's clock events carry negative ids (no real
    // scan behind them) — an objection against one is a day objection.
    const scanId = dto.scan_id && dto.scan_id > 0 ? dto.scan_id : null;
    // TAFSD-490: only a whole-day objection carries a clock-out of its own.
    let claimedCheckOut: Date | null = null;
    if (dto.claimed_check_out_time) {
      if (scanId) throw new BadRequestException('A clock-out time is only for a whole-day objection');
      claimedCheckOut = new Date(dto.claimed_check_out_time);
      if (Number.isNaN(claimedCheckOut.getTime())) throw new BadRequestException('Invalid claimed_check_out_time');
      if (claimedCheckOut <= claimedTime) throw new BadRequestException('Clock-out must be after clock-in');
    }
    let originalScanTime: Date | null = null;
    if (scanId) {
      const scan = await this.prisma.zk_attendance_scans.findFirst({
        where: { id: scanId, employee_id: employee.id },
      });
      if (!scan) throw new BadRequestException('Scan not found for this employee');
      originalScanTime = scan.scan_time;
    }

    const objection = await this.prisma.attendance_objections.create({
      data: {
        employee_id: employee.id,
        attendance_date: attendanceDate,
        scan_id: scanId,
        original_scan_time: originalScanTime,
        claimed_time: claimedTime,
        claimed_check_out_time: claimedCheckOut,
        reason: dto.reason,
        status: AttendanceObjectionStatus.PENDING,
      },
    });

    await this.notifyReviewers(employee.full_name ?? 'Employee', attendanceDate);
    return objection;
  }

  async listMine(userId: string) {
    const employee = await this.employeeResolver.requireByUserId(userId);
    return this.prisma.attendance_objections.findMany({
      where: { employee_id: employee.id },
      include: {
        scan: { select: { id: true, scan_time: true, direction: true } },
        reviewer: { select: { id: true, full_name: true, username: true, role: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async listForReview(query: ListAttendanceObjectionsQueryDto, user: IJwtStaffPayload) {
    const campusIds = query.campus_id?.length ? query.campus_id : undefined;
    if (campusIds?.length) {
      for (const campusId of campusIds) {
        this.assertCampusAccess(user, campusId);
      }
    }

    // campus_id is pulled out and intersected, not spread, so it never
    // silently overwrites (or gets overwritten by) the campusIds filter
    // below. See the scope-sweep handoff.
    const { campus_id: universalCampusFilter, ...restUniversalScope } =
      this.scope.whereForEmployees(user);
    const universalCampusIds = universalCampusFilter?.in;
    const effectiveCampusIds = universalCampusIds
      ? campusIds?.length
        ? campusIds.filter((id) => universalCampusIds.includes(id))
        : universalCampusIds
      : campusIds;

    const objections = await this.prisma.attendance_objections.findMany({
      where: {
        ...(query.status?.length ? { status: { in: query.status } } : {}),
        employee: {
          ...(effectiveCampusIds !== undefined ? { campus_id: { in: effectiveCampusIds } } : {}),
          ...restUniversalScope,
        },
      },
      include: {
        employee: {
          select: { id: true, full_name: true, employee_code: true, campus_id: true },
        },
        scan: { select: { id: true, scan_time: true, direction: true } },
        reviewer: { select: { id: true, full_name: true, username: true, role: true } },
      },
      orderBy: { created_at: 'desc' },
    });
    return this.withDayScans(objections);
  }

  /**
   * TAFSD-474: each objection with that day's punches, so a reviewer always
   * sees what is being objected to — including a "missing clock-out" or
   * "whole day" objection, which carries no scan_id but usually has punches.
   */
  private async withDayScans<T extends { employee_id: number; attendance_date: Date }>(objections: T[]) {
    if (objections.length === 0) return [];
    const dayKey = (employeeId: number, date: Date) => `${employeeId}:${date.toISOString().slice(0, 10)}`;
    const pairs = [...new Map(objections.map((o) => [dayKey(o.employee_id, o.attendance_date), o])).values()];
    const scans = await this.prisma.zk_attendance_scans.findMany({
      where: {
        person_type: 'STAFF',
        is_duplicate: false,
        OR: pairs.map((o) => ({ employee_id: o.employee_id, attendance_date: o.attendance_date })),
      },
      select: { id: true, employee_id: true, attendance_date: true, scan_time: true, direction: true, work_code: true },
      orderBy: { scan_time: 'asc' },
    });
    const byDay = new Map<string, { id: number; scan_time: Date; direction: string | null; work_code: string | null }[]>();
    for (const s of scans) {
      if (s.employee_id == null) continue;
      const key = dayKey(s.employee_id, s.attendance_date);
      const bucket = byDay.get(key) ?? [];
      bucket.push({ id: s.id, scan_time: s.scan_time, direction: s.direction, work_code: s.work_code });
      byDay.set(key, bucket);
    }
    return objections.map((o) => ({ ...o, day_scans: byDay.get(dayKey(o.employee_id, o.attendance_date)) ?? [] }));
  }

  /** The day's real punches (oldest first) and its attendance row. */
  private async dayState(employeeId: number, date: Date) {
    const [scans, record] = await Promise.all([
      this.prisma.zk_attendance_scans.findMany({
        where: { person_type: 'STAFF', is_duplicate: false, employee_id: employeeId, attendance_date: date },
        orderBy: { scan_time: 'asc' },
        select: { id: true, scan_time: true },
      }),
      this.prisma.attendance_staff_daily.findUnique({
        where: { employee_id_date: { employee_id: employeeId, date } },
        select: { check_in_at: true, check_out_at: true },
      }),
    ]);
    return { scans, record };
  }

  async review(id: number, dto: ReviewAttendanceObjectionDto, user: IJwtStaffPayload) {
    if (dto.status === AttendanceObjectionStatus.PENDING) {
      throw new BadRequestException('Status must be ACCEPTED or REJECTED');
    }
    if (dto.status === AttendanceObjectionStatus.REJECTED && !dto.admin_notes?.trim()) {
      throw new BadRequestException('admin_notes is required when rejecting an objection');
    }

    const existing = await this.prisma.attendance_objections.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            campus_id: true,
            segment_id: true,
            department_id: true,
            staff_category_id: true,
            user_id: true,
            full_name: true,
            employee_code: true,
            leaving_time: true,
            reporting_time: true,
            employee_day_timings: { select: { day_of_week: true, reporting_time: true, leaving_time: true } },
          },
        },
        scan: { select: { id: true, scan_time: true, direction: true, device_sn: true, device_pin: true } },
      },
    });
    if (!existing) throw new NotFoundException('Objection not found');
    // (60) An objection is decided once; a second decision would leave the
    // day rewritten under a different status.
    if (existing.status !== AttendanceObjectionStatus.PENDING) {
      throw new ConflictException(`This objection was already ${existing.status.toLowerCase()}.`);
    }
    if (existing.employee.campus_id) {
      this.assertCampusAccess(user, existing.employee.campus_id);
    }
    // Covers segment/department/category, which the legacy campus-only check never did.
    this.scope.assertEmployee(user, existing.employee);
    // Accepting rewrites the attendance day, so the same rule as a manual
    // override applies: nobody decides their own objection.
    if (user.role !== StaffRole.SUPER_ADMIN && existing.employee.user_id === user.sub) {
      throw new ForbiddenException('You cannot review your own attendance objection.');
    }
    await assertMayChangeEmployee(this.prisma, user, existing.employee.id, 'attendance objection');

    // Claim it atomically, so two reviewers acting at once can't both decide.
    const claimed = await this.prisma.attendance_objections.updateMany({
      where: { id, status: AttendanceObjectionStatus.PENDING },
      data: {
        status: dto.status,
        admin_notes: dto.admin_notes ?? null,
        reviewed_by: user.sub,
        reviewed_at: new Date(),
        // Objections raised before TAFSD-474 have no snapshot; take it now,
        // before accepting rewrites the scan's time below.
        ...(existing.original_scan_time == null && existing.scan
          ? { original_scan_time: existing.scan.scan_time }
          : {}),
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException('This objection was just decided by someone else.');
    }
    const updated = await this.prisma.attendance_objections.findUniqueOrThrow({
      where: { id },
      include: {
        employee: { select: { id: true, full_name: true, employee_code: true } },
        scan: { select: { id: true, scan_time: true, direction: true } },
        reviewer: { select: { id: true, full_name: true, username: true, role: true } },
      },
    });

    if (dto.status === AttendanceObjectionStatus.ACCEPTED) {
      // The day as it was, before step 1 moves the objected punch.
      const { scans: dayScans, record } = await this.dayState(existing.employee_id, existing.attendance_date);

      // 1. Tag the biometric scan and update its time if possible
      if (existing.scan_id) {
        try {
          await this.prisma.zk_attendance_scans.update({
            where: { id: existing.scan_id },
            data: {
              work_code: 'OBJECTION_ACCEPTED',
              scan_time: existing.claimed_time,
            },
          });
        } catch {
          await this.prisma.zk_attendance_scans.update({
            where: { id: existing.scan_id },
            data: { work_code: 'OBJECTION_ACCEPTED' },
          });
        }
      }

      // 2. Correct the daily attendance record.
      const noteText = dto.admin_notes?.trim()
        ? `Objection accepted: ${dto.admin_notes.trim()}`
        : `Objection accepted: ${existing.reason}`;

      let checkInAt: Date | undefined = undefined;
      let checkOutAt: Date | undefined = undefined;

      if (existing.scan_id) {
        // (59) A punch with no direction is read by position, as payroll
        // does: punches alternate in, out, in, out.
        const index = dayScans.findIndex((s) => s.id === existing.scan_id);
        const isCheckOut =
          existing.scan?.direction === 'OUT' ||
          (existing.scan?.direction == null && index >= 0 && index % 2 === 1);
        if (isCheckOut) {
          checkOutAt = existing.claimed_time;
        } else {
          checkInAt = existing.claimed_time;
        }
      } else {
        // TAFSD-479: the staff app sends "Missing clock-out" with no scan — the
        // day has an odd number of punches, or an override with a check-in and
        // no check-out. Keep the arrival; the claimed time is the leaving time.
        const arrival = dayScans.length
          ? dayScans.length % 2 === 1
            ? dayScans[0].scan_time
            : null
          : record?.check_in_at && !record.check_out_at
            ? record.check_in_at
            : null;
        if (arrival && !existing.claimed_check_out_time && existing.claimed_time > arrival) {
          checkInAt = arrival;
          checkOutAt = existing.claimed_time;
        } else {
          // Whole-day objection: the claimed time is the arrival.
          checkInAt = existing.claimed_time;
          if (existing.claimed_check_out_time) {
            // TAFSD-490: the employee gave the day's clock-out too.
            checkOutAt = existing.claimed_check_out_time;
          } else {
            // (58) Keep a real leaving time — the last punch of a complete day,
            // else an override's check-out — and fall back to the schedule's
            // leaving time only when the day has none.
            const realLeaving =
              dayScans.length >= 2 && dayScans.length % 2 === 0
                ? dayScans[dayScans.length - 1].scan_time
                : (record?.check_out_at ?? null);
            if (realLeaving && realLeaving > existing.claimed_time) {
              checkOutAt = realLeaving;
            } else {
              // That weekday's leaving time (TAFSD-363: Friday may differ).
              const leavingTime = timingsForDate(
                existing.employee,
                existing.employee.employee_day_timings,
                new Date(existing.attendance_date),
              ).leaving_time;
              if (leavingTime) {
                const lt = new Date(leavingTime);
                const d = new Date(existing.attendance_date);
                checkOutAt = new Date(
                  Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), lt.getUTCHours(), lt.getUTCMinutes(), 0),
                );
              }
            }
          }
        }
      }

      const targetCampusId = existing.employee.campus_id ?? user.campusId;
      if (targetCampusId) {
        // (57) Accepting corrects the times; it doesn't forgive lateness. A
        // manual PRESENT reads as forgiven in payroll, so a corrected check-in
        // that is still late is saved as LATE.
        const finalCheckIn = checkInAt ?? record?.check_in_at ?? null;
        const expected = await this.expectedTimes.resolveExpectedTimes(
          existing.employee_id,
          targetCampusId,
          existing.attendance_date,
        );
        const status =
          finalCheckIn &&
          expected.expectedCheckIn &&
          isLateCheckIn(finalCheckIn, expected.expectedCheckIn, expected.graceMinutes)
            ? StaffAttendanceStatus.LATE
            : StaffAttendanceStatus.PRESENT;
        await this.prisma.attendance_staff_daily.upsert({
          where: {
            employee_id_date: {
              employee_id: existing.employee_id,
              date: existing.attendance_date,
            },
          },
          create: {
            employee_id: existing.employee_id,
            campus_id: targetCampusId,
            date: existing.attendance_date,
            status,
            source: AttendanceSource.MANUAL,
            check_in_at: checkInAt,
            check_out_at: checkOutAt,
            notes: noteText,
            marked_by: user.sub,
          },
          update: {
            status,
            source: AttendanceSource.MANUAL,
            ...(checkInAt !== undefined ? { check_in_at: checkInAt } : {}),
            ...(checkOutAt !== undefined ? { check_out_at: checkOutAt } : {}),
            notes: noteText,
            marked_by: user.sub,
          },
        });
      }

      // 3. Clear any pending payroll flags for this employee & date
      try {
        await this.prisma.payroll_flags.deleteMany({
          where: {
            employee_id: existing.employee_id,
            anchor_date: existing.attendance_date,
            status: 'PENDING',
          },
        });
      } catch {
        // Non-fatal if payroll flags model structure varies
      }
    }

    // TAFSD-513 (item 68): the decision lands in the staff app's notice inbox
    // with a push (StaffNotificationsService), with Notification Templates text.
    if (existing.employee.user_id) {
      const isAccepted = dto.status === AttendanceObjectionStatus.ACCEPTED;
      const dateLabel = existing.attendance_date.toISOString().slice(0, 10);
      const outcome = isAccepted ? 'accepted' : 'rejected';
      const text = await renderNotification(
        this.prisma,
        `notif_staff_objection_${outcome}`,
        isAccepted
          ? { title: 'Attendance objection accepted', body: 'Your attendance objection for {date} was accepted.{note_clause}' }
          : { title: 'Attendance objection rejected', body: 'Your attendance objection for {date} was rejected.{note_clause}' },
        {
          date: dateLabel,
          note: dto.admin_notes?.trim() ?? '',
          note_clause: clause(isAccepted ? 'Note' : 'Reason', dto.admin_notes),
        },
      );
      if (text) {
        await this.staffNotifications.notify(existing.employee.user_id, {
          kind: `OBJECTION_${outcome.toUpperCase()}`,
          title: text.title,
          body: text.body,
          link: '/hr/attendance-objections',
          entityType: 'ATTENDANCE_OBJECTION',
          entityId: String(id),
          pushData: {
            status: dto.status,
            objection_id: String(id),
            date: dateLabel,
            route: '/my-objections',
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
          },
        });
      }
    }

    const employeeLabel = updated.employee.full_name
      ? `${updated.employee.full_name}${updated.employee.employee_code ? ` (${updated.employee.employee_code})` : ''}`
      : updated.employee.employee_code ?? 'Unknown employee';
    const attendanceDateStr = existing.attendance_date.toISOString().slice(0, 10);
    const claimedTimeStr = existing.claimed_check_out_time
      ? `${existing.claimed_time.toISOString().slice(11, 16)}–${existing.claimed_check_out_time.toISOString().slice(11, 16)}`
      : existing.claimed_time.toISOString().slice(11, 16);
    const appliedDateStr = existing.created_at.toISOString().slice(0, 10);
    const recordedTimeStr = updated.scan
      ? `${updated.scan.scan_time.toISOString().slice(11, 16)} (${updated.scan.direction})`
      : 'no matching scan on record';

    void this.auditLogs.log({
      entity_type: 'ATTENDANCE_OBJECTION',
      entity_id: String(id),
      action: dto.status === AttendanceObjectionStatus.ACCEPTED ? 'ACCEPTED' : 'REJECTED',
      field: 'status',
      old_value: 'PENDING',
      new_value: dto.status,
      changed_by: auditActorLabel(user),
      note: [
        `Attendance objection for ${employeeLabel} — ${attendanceDateStr}: recorded time ${recordedTimeStr}, claimed time ${claimedTimeStr}.`,
        `Applied ${appliedDateStr} — "${existing.reason}".`,
        dto.admin_notes?.trim() ? `Decision: ${dto.admin_notes.trim()}` : null,
      ]
        .filter(Boolean)
        .join(' '),
    });

    return updated;
  }

  async countPending(user: IJwtStaffPayload): Promise<{ count: number }> {
    const count = await this.prisma.attendance_objections.count({
      where: {
        status: AttendanceObjectionStatus.PENDING,
        employee: this.scope.whereForEmployees(user),
      },
    });
    return { count };
  }

  private async notifyReviewers(employeeName: string, date: Date) {
    const perm = await this.prisma.permissions.findUnique({
      where: { key: 'hr.objections.review' },
    });
    if (!perm) return;

    const roleRows = await this.prisma.role_permissions.findMany({
      where: { permission_id: perm.id },
      select: { role: true },
    });
    const rolesWithPerm = roleRows.map((r) => r.role);

    const users = await this.prisma.users.findMany({
      where: {
        is_active: true,
        deleted_at: null,
        OR: [
          { role: StaffRole.SUPER_ADMIN },
          ...(rolesWithPerm.length > 0 ? [{ role: { in: rolesWithPerm } }] : []),
          {
            user_permissions: {
              some: { permission_id: perm.id },
            },
          },
        ],
      },
      select: { id: true },
    });

    const userIds = [...new Set(users.map((u) => u.id))];
    if (userIds.length === 0) return;

    const dateLabel = date.toISOString().slice(0, 10);
    // TAFSD-514: text from the Notification Templates page.
    const text = await renderNotification(
      this.prisma,
      'notif_staff_objection_new',
      { title: 'Attendance objection filed', body: '{employee_name} filed an objection for {date}' },
      { employee_name: employeeName, date: dateLabel },
    );
    if (!text) return;
    await this.fcmService.sendToUsers(
      userIds,
      text.title,
      text.body,
      {
        type: 'attendance_objection',
        date: dateLabel,
        route: '/hr/objections',
        click_action: '/hr/objections',
      },
    );
  }
}
