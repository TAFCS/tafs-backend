import {
  BadRequestException,
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
import { EmployeeProfileResolverService } from '../hr/employee-profile-resolver.service';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import {
  CreateAttendanceObjectionDto,
  ListAttendanceObjectionsQueryDto,
  ReviewAttendanceObjectionDto,
} from './dto/attendance-objections.dto';

@Injectable()
export class AttendanceObjectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly employeeResolver: EmployeeProfileResolverService,
    private readonly fcmService: FcmService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private parseDate(dateStr: string): Date {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private assertCampusAccess(user: IJwtStaffPayload, campusId: number) {
    if (user.campusId && user.campusId !== campusId) {
      throw new ForbiddenException('You do not have access to this campus');
    }
  }

  async create(userId: string, dto: CreateAttendanceObjectionDto) {
    const employee = await this.employeeResolver.requireByUserId(userId);
    const attendanceDate = this.parseDate(dto.attendance_date);
    const claimedTime = new Date(dto.claimed_time);
    if (Number.isNaN(claimedTime.getTime())) {
      throw new BadRequestException('Invalid claimed_time');
    }

    if (dto.scan_id) {
      const scan = await this.prisma.zk_attendance_scans.findFirst({
        where: { id: dto.scan_id, employee_id: employee.id },
      });
      if (!scan) throw new BadRequestException('Scan not found for this employee');
    }

    const objection = await this.prisma.attendance_objections.create({
      data: {
        employee_id: employee.id,
        attendance_date: attendanceDate,
        scan_id: dto.scan_id ?? null,
        claimed_time: claimedTime,
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
        reviewer: { select: { id: true, full_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async listForReview(query: ListAttendanceObjectionsQueryDto, user: IJwtStaffPayload) {
    const campusIds =
      query.campus_id?.length
        ? query.campus_id
        : user.campusId != null
          ? [user.campusId]
          : undefined;
    if (campusIds?.length) {
      for (const campusId of campusIds) {
        this.assertCampusAccess(user, campusId);
      }
    }

    return this.prisma.attendance_objections.findMany({
      where: {
        ...(query.status?.length ? { status: { in: query.status } } : {}),
        ...(campusIds?.length ? { employee: { campus_id: { in: campusIds } } } : {}),
      },
      include: {
        employee: {
          select: { id: true, full_name: true, employee_code: true, campus_id: true },
        },
        scan: { select: { id: true, scan_time: true, direction: true } },
        reviewer: { select: { id: true, full_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });
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
            user_id: true,
            full_name: true,
            employee_code: true,
            leaving_time: true,
            reporting_time: true,
          },
        },
        scan: { select: { id: true, scan_time: true, direction: true, device_sn: true, device_pin: true } },
      },
    });
    if (!existing) throw new NotFoundException('Objection not found');
    if (existing.employee.campus_id) {
      this.assertCampusAccess(user, existing.employee.campus_id);
    }

    const updated = await this.prisma.attendance_objections.update({
      where: { id },
      data: {
        status: dto.status,
        admin_notes: dto.admin_notes ?? null,
        reviewed_by: user.sub,
        reviewed_at: new Date(),
      },
      include: {
        employee: { select: { id: true, full_name: true, employee_code: true } },
        scan: { select: { id: true, scan_time: true, direction: true } },
        reviewer: { select: { id: true, full_name: true } },
      },
    });

    if (dto.status === AttendanceObjectionStatus.ACCEPTED) {
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

      // 2. Correct the daily attendance record (status -> PRESENT, check_in_at/check_out_at -> claimed_time)
      const isCheckOut = existing.scan?.direction === 'OUT';
      const noteText = dto.admin_notes?.trim()
        ? `Objection accepted: ${dto.admin_notes.trim()}`
        : `Objection accepted: ${existing.reason}`;

      let checkInAt: Date | undefined = undefined;
      let checkOutAt: Date | undefined = undefined;

      if (existing.scan_id) {
        if (isCheckOut) {
          checkOutAt = existing.claimed_time;
        } else {
          checkInAt = existing.claimed_time;
        }
      } else {
        // Day-level objection (zero biometric scans recorded for the day):
        // Record claimed arrival as check_in_at, and derive check_out_at from employee leaving_time if configured
        checkInAt = existing.claimed_time;
        if (existing.employee.leaving_time) {
          const lt = new Date(existing.employee.leaving_time);
          const d = new Date(existing.attendance_date);
          checkOutAt = new Date(
            Date.UTC(
              d.getUTCFullYear(),
              d.getUTCMonth(),
              d.getUTCDate(),
              lt.getUTCHours(),
              lt.getUTCMinutes(),
              0,
            ),
          );
        }
      }

      const targetCampusId = existing.employee.campus_id ?? user.campusId;
      if (targetCampusId) {
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
            status: StaffAttendanceStatus.PRESENT,
            source: AttendanceSource.MANUAL,
            check_in_at: checkInAt,
            check_out_at: checkOutAt,
            notes: noteText,
            marked_by: user.sub,
          },
          update: {
            status: StaffAttendanceStatus.PRESENT,
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

    // Notify the employee directly via FCM
    if (existing.employee.user_id) {
      const isAccepted = dto.status === AttendanceObjectionStatus.ACCEPTED;
      const dateLabel = existing.attendance_date.toISOString().slice(0, 10);
      const title = isAccepted
        ? 'Attendance objection accepted'
        : 'Attendance objection rejected';
      const body = isAccepted
        ? `Your attendance objection for ${dateLabel} was accepted.${dto.admin_notes?.trim() ? ` Note: ${dto.admin_notes.trim()}` : ''}`
        : `Your attendance objection for ${dateLabel} was rejected.${dto.admin_notes?.trim() ? ` Reason: ${dto.admin_notes.trim()}` : ''}`;

      await this.fcmService.sendToUsers(
        [existing.employee.user_id],
        title,
        body,
        {
          type: 'attendance_objection_decision',
          status: dto.status,
          objection_id: String(id),
          date: dateLabel,
          route: '/my-objections',
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
      );
    }

    const employeeLabel = updated.employee.full_name
      ? `${updated.employee.full_name}${updated.employee.employee_code ? ` (${updated.employee.employee_code})` : ''}`
      : updated.employee.employee_code ?? 'Unknown employee';
    const attendanceDateStr = existing.attendance_date.toISOString().slice(0, 10);
    const claimedTimeStr = existing.claimed_time.toISOString().slice(11, 16);
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
    const campusIds = user.campusId != null ? [user.campusId] : undefined;
    const count = await this.prisma.attendance_objections.count({
      where: {
        status: AttendanceObjectionStatus.PENDING,
        ...(campusIds?.length ? { employee: { campus_id: { in: campusIds } } } : {}),
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
    await this.fcmService.sendToUsers(
      userIds,
      'Attendance objection filed',
      `${employeeName} filed an objection for ${dateLabel}`,
      {
        type: 'attendance_objection',
        date: dateLabel,
        route: '/hr/objections',
        click_action: '/hr/objections',
      },
    );
  }
}
