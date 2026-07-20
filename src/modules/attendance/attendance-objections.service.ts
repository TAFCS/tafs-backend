import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceObjectionStatus, StaffRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { FcmService } from '../../common/fcm/fcm.service';
import { EmployeeProfileResolverService } from '../hr/employee-profile-resolver.service';
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
    const campusId = query.campus_id ?? user.campusId ?? undefined;
    if (campusId) {
      this.assertCampusAccess(user, campusId);
    }

    return this.prisma.attendance_objections.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(campusId ? { employee: { campus_id: campusId } } : {}),
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
      include: { employee: { select: { campus_id: true } } },
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

    if (dto.status === AttendanceObjectionStatus.ACCEPTED && existing.scan_id) {
      await this.prisma.zk_attendance_scans.update({
        where: { id: existing.scan_id },
        data: { work_code: 'OBJECTION_ACCEPTED' },
      });
    }

    void this.auditLogs.log({
      entity_type: 'ATTENDANCE_OBJECTION',
      entity_id: String(id),
      action: dto.status === AttendanceObjectionStatus.ACCEPTED ? 'ACCEPTED' : 'REJECTED',
      field: 'status',
      old_value: 'PENDING',
      new_value: dto.status,
      changed_by: user.username,
      note: dto.admin_notes?.trim() || undefined,
    });

    return updated;
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
      { type: 'attendance_objection', date: dateLabel },
    );
  }
}
