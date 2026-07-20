import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LeaveRequestStatus, Prisma, StaffRole } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { FcmService } from '../../../common/fcm/fcm.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { EmployeeProfileResolverService } from '../employee-profile-resolver.service';
import {
  CreateLeaveRequestDto,
  ListLeaveRequestsQueryDto,
  ReviewLeaveRequestDto,
  RevokeLeaveRequestDto,
} from './dto/leave-requests.dto';
import { LeaveAttendanceSyncService } from './leave-attendance-sync.service';

const LEAVE_INCLUDE = {
  leave_types: { select: { id: true, code: true, name: true, is_paid: true } },
  employee_profiles: {
    select: {
      id: true,
      full_name: true,
      employee_code: true,
      campus_id: true,
      is_permanent_employee: true,
      join_date: true,
      campuses: { select: { id: true, campus_name: true } },
    },
  },
  reviewer: { select: { id: true, full_name: true } },
} satisfies Prisma.leave_requestsInclude;

@Injectable()
export class LeaveRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profileResolver: EmployeeProfileResolverService,
    private readonly attendanceSync: LeaveAttendanceSyncService,
    private readonly fcmService: FcmService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async create(userId: string, dto: CreateLeaveRequestDto) {
    const profile = await this.prisma.employee_profiles.findUnique({
      where: { user_id: userId },
      select: {
        id: true,
        full_name: true,
        campus_id: true,
        is_permanent_employee: true,
        join_date: true,
      },
    });
    if (!profile) {
      throw new ForbiddenException('No employee profile is linked to this account');
    }

    const leaveType = await this.prisma.leave_types.findUnique({
      where: { code: dto.leaveTypeCode.toUpperCase() },
    });
    if (!leaveType) throw new BadRequestException('Invalid leave type');
    if (!leaveType.code) throw new BadRequestException('Leave type is not configured');

    this.validateTypeRules(leaveType.code, dto, profile);
    this.validateAttachmentUrl(dto.attachmentUrl, profile.id);

    const startDate = this.parseDate(dto.startDate);
    const endDate = this.parseDate(dto.endDate);
    if (endDate < startDate) {
      throw new BadRequestException('End date must be on or after start date');
    }

    await this.assertNoOverlap(profile.id, startDate, endDate);

    const request = await this.prisma.leave_requests.create({
      data: {
        employee_id: profile.id,
        leave_type_id: leaveType.id,
        start_date: startDate,
        end_date: endDate,
        reason: dto.reason?.trim() || null,
        attachment_url: dto.attachmentUrl?.trim() || null,
        attachment_type: dto.attachmentType?.trim() || null,
      },
      include: LEAVE_INCLUDE,
    });

    void this.notifyApprovers(profile.full_name ?? 'Employee', leaveType.name, startDate, profile.campus_id);
    return request;
  }

  async listMine(userId: string) {
    const profile = await this.profileResolver.requireByUserId(userId);
    return this.prisma.leave_requests.findMany({
      where: { employee_id: profile.id },
      include: LEAVE_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
  }

  async getSelfContext(userId: string) {
    const profile = await this.prisma.employee_profiles.findUnique({
      where: { user_id: userId },
      select: { id: true, is_permanent_employee: true, join_date: true, full_name: true },
    });
    if (!profile) {
      throw new ForbiddenException('No employee profile is linked to this account');
    }
    const leaveTypes = await this.prisma.leave_types.findMany({
      select: { id: true, code: true, name: true, is_paid: true },
    });
    const typeOrder = ['SICK', 'CASUAL', 'ANNUAL', 'UNPAID'];
    leaveTypes.sort(
      (a, b) =>
        (typeOrder.indexOf(a.code) === -1 ? 99 : typeOrder.indexOf(a.code)) -
        (typeOrder.indexOf(b.code) === -1 ? 99 : typeOrder.indexOf(b.code)),
    );
    return {
      employeeId: profile.id,
      isPermanentEmployee: this.isPermanentEmployee(profile),
      leaveTypes,
    };
  }

  async cancelMine(userId: string, id: number) {
    const profile = await this.profileResolver.requireByUserId(userId);
    const request = await this.prisma.leave_requests.findFirst({
      where: { id, employee_id: profile.id },
    });
    if (!request) throw new NotFoundException('Leave request not found');
    if (request.status !== LeaveRequestStatus.PENDING) {
      throw new BadRequestException('Only pending requests can be cancelled');
    }

    await this.prisma.leave_requests.delete({ where: { id } });
    return { id };
  }

  async listForReview(query: ListLeaveRequestsQueryDto, user: IJwtStaffPayload) {
    this.assertApprovePermission(user);

    const campusId = this.resolveCampusFilter(query.campusId, user);
    if (user.campusId && campusId && user.campusId !== campusId) {
      throw new ForbiddenException('You do not have access to this campus');
    }

    const where: Prisma.leave_requestsWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.leaveTypeCode
        ? { leave_types: { code: query.leaveTypeCode.toUpperCase() } }
        : {}),
      ...(campusId ? { employee_profiles: { campus_id: campusId } } : {}),
      ...(query.fromDate || query.toDate
        ? {
            AND: [
              query.toDate ? { start_date: { lte: this.parseDate(query.toDate) } } : {},
              query.fromDate ? { end_date: { gte: this.parseDate(query.fromDate) } } : {},
            ],
          }
        : {}),
    };

    return this.prisma.leave_requests.findMany({
      where,
      include: LEAVE_INCLUDE,
      orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
    });
  }

  async getById(id: number, user: IJwtStaffPayload) {
    this.assertApprovePermission(user);
    const request = await this.prisma.leave_requests.findUnique({
      where: { id },
      include: LEAVE_INCLUDE,
    });
    if (!request) throw new NotFoundException('Leave request not found');
    this.assertCampusAccess(user, request.employee_profiles.campus_id);
    return request;
  }

  async review(id: number, dto: ReviewLeaveRequestDto, user: IJwtStaffPayload) {
    this.assertApprovePermission(user);

    if (dto.status !== LeaveRequestStatus.APPROVED && dto.status !== LeaveRequestStatus.REJECTED) {
      throw new BadRequestException('Review status must be APPROVED or REJECTED');
    }
    if (dto.status === LeaveRequestStatus.REJECTED && !dto.reviewReason?.trim()) {
      throw new BadRequestException('Rejection reason is required');
    }

    const existing = await this.getById(id, user);
    if (existing.status !== LeaveRequestStatus.PENDING) {
      throw new BadRequestException('Only pending requests can be reviewed');
    }

    if (dto.status === LeaveRequestStatus.APPROVED) {
      if (!existing.employee_profiles.campus_id) {
        throw new BadRequestException('Employee has no campus assigned — cannot sync attendance');
      }
      await this.assertNoOverlap(
        existing.employee_id,
        existing.start_date,
        existing.end_date,
        id,
      );
    }

    const updated = await this.prisma.leave_requests.update({
      where: { id },
      data: {
        status: dto.status,
        review_reason: dto.reviewReason?.trim() || null,
        reviewed_by: user.sub,
        reviewed_at: new Date(),
      },
      include: LEAVE_INCLUDE,
    });

    if (dto.status === LeaveRequestStatus.APPROVED) {
      try {
        await this.attendanceSync.syncApprovedLeaveToAttendance(id);
      } catch (err) {
        await this.prisma.leave_requests.update({
          where: { id },
          data: {
            status: LeaveRequestStatus.PENDING,
            review_reason: null,
            reviewed_by: null,
            reviewed_at: null,
          },
        });
        throw err;
      }
    }

    void this.auditLogs.log({
      entity_type: 'LEAVE_REQUEST',
      entity_id: String(id),
      action: dto.status === LeaveRequestStatus.APPROVED ? 'APPROVED' : 'REJECTED',
      field: 'status',
      old_value: 'PENDING',
      new_value: dto.status,
      changed_by: user.username,
      note: dto.reviewReason?.trim() || undefined,
    });

    void this.notifyEmployeeReview(existing, dto.status, id);
    return updated;
  }

  async revoke(id: number, dto: RevokeLeaveRequestDto, user: IJwtStaffPayload) {
    this.assertApprovePermission(user);

    const reason = dto.reviewReason?.trim();
    if (!reason) {
      throw new BadRequestException('Revocation reason is required');
    }

    const existing = await this.getById(id, user);
    if (existing.status !== LeaveRequestStatus.APPROVED) {
      throw new BadRequestException('Only approved requests can be revoked');
    }

    await this.attendanceSync.revertLeaveAttendance(id);

    const updated = await this.prisma.leave_requests.update({
      where: { id },
      data: {
        status: LeaveRequestStatus.REJECTED,
        review_reason: reason,
        reviewed_by: user.sub,
        reviewed_at: new Date(),
      },
      include: LEAVE_INCLUDE,
    });

    void this.auditLogs.log({
      entity_type: 'LEAVE_REQUEST',
      entity_id: String(id),
      action: 'REVOKED',
      field: 'status',
      old_value: 'APPROVED',
      new_value: 'REJECTED',
      changed_by: user.username,
      note: reason,
    });

    void this.notifyEmployeeReview(existing, LeaveRequestStatus.REJECTED, id, 'revoked');
    return updated;
  }

  private validateTypeRules(
    code: string,
    dto: CreateLeaveRequestDto,
    profile: { is_permanent_employee: boolean; join_date: Date | null },
  ) {
    switch (code) {
      case 'CASUAL':
        if (!this.isPermanentEmployee(profile)) {
          throw new BadRequestException(
            'Casual leave is only available after 14 months of service',
          );
        }
        break;
      case 'SICK':
        if (!dto.attachmentUrl?.trim() || !dto.attachmentType?.trim()) {
          throw new BadRequestException('Sick leave requires an attachment');
        }
        if (dto.attachmentType !== 'image' && dto.attachmentType !== 'document') {
          throw new BadRequestException('Attachment type must be image or document');
        }
        break;
      case 'ANNUAL':
      case 'UNPAID':
        if (!dto.reason?.trim()) {
          throw new BadRequestException('Reason is required for this leave type');
        }
        break;
      default:
        throw new BadRequestException('Unsupported leave type');
    }
  }

  private validateAttachmentUrl(url: string | undefined, employeeId: number) {
    if (!url?.trim()) return;
    const normalized = url.trim();
    const expectedSegment = `/employees/${employeeId}/leave-`;
    if (!normalized.includes(expectedSegment)) {
      throw new BadRequestException('Attachment must be uploaded for this employee');
    }
  }

  private isPermanentEmployee(profile: {
    is_permanent_employee: boolean;
    join_date: Date | null;
  }): boolean {
    if (profile.is_permanent_employee) return true;
    if (!profile.join_date) return false;
    const cutoff = new Date();
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 14);
    cutoff.setUTCHours(0, 0, 0, 0);
    return profile.join_date <= cutoff;
  }

  private async assertNoOverlap(
    employeeId: number,
    start: Date,
    end: Date,
    excludeId?: number,
  ) {
    const overlap = await this.prisma.leave_requests.findFirst({
      where: {
        employee_id: employeeId,
        status: { in: [LeaveRequestStatus.PENDING, LeaveRequestStatus.APPROVED] },
        start_date: { lte: end },
        end_date: { gte: start },
        ...(excludeId != null ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (overlap) {
      throw new BadRequestException('Leave dates overlap an existing pending or approved request');
    }
  }

  private parseDate(dateStr: string): Date {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private resolveCampusFilter(
    queryCampusId: number | undefined,
    user: IJwtStaffPayload,
  ): number | undefined {
    if (user.role === StaffRole.SUPER_ADMIN) {
      return queryCampusId;
    }
    if (user.campusId) {
      return queryCampusId ?? user.campusId;
    }
    return queryCampusId;
  }

  private assertCampusAccess(user: IJwtStaffPayload, employeeCampusId: number | null) {
    if (user.role === StaffRole.SUPER_ADMIN) return;
    if (user.campusId && employeeCampusId && user.campusId !== employeeCampusId) {
      throw new ForbiddenException('You do not have access to this leave request');
    }
  }

  private assertApprovePermission(user: IJwtStaffPayload) {
    if (user.role === StaffRole.SUPER_ADMIN) return;
    if (user.permissions?.includes('hr.leave.approve')) return;
    throw new ForbiddenException('Your account does not have permission: hr.leave.approve');
  }

  private async notifyEmployeeReview(
    existing: Prisma.leave_requestsGetPayload<{ include: typeof LEAVE_INCLUDE }>,
    status: LeaveRequestStatus,
    id: number,
    labelOverride?: string,
  ) {
    const employeeUser = await this.prisma.employee_profiles.findUnique({
      where: { id: existing.employee_id },
      select: { user_id: true },
    });
    if (!employeeUser?.user_id) return;

    const label =
      labelOverride ??
      (status === LeaveRequestStatus.APPROVED ? 'approved' : 'rejected');
    void this.fcmService.sendToUsers(
      [employeeUser.user_id],
      `Leave request ${label}`,
      `Your ${existing.leave_types.name} request was ${label}.`,
      { type: 'leave_request', leave_request_id: String(id), status },
    );
  }

  private async notifyApprovers(
    employeeName: string,
    leaveTypeName: string,
    startDate: Date,
    campusId: number | null,
  ) {
    const perm = await this.prisma.permissions.findUnique({
      where: { key: 'hr.leave.approve' },
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
        AND: [
          {
            OR: [
              { role: StaffRole.SUPER_ADMIN },
              ...(rolesWithPerm.length > 0 ? [{ role: { in: rolesWithPerm } }] : []),
              { user_permissions: { some: { permission_id: perm.id } } },
            ],
          },
          ...(campusId != null
            ? [
                {
                  OR: [
                    { role: StaffRole.SUPER_ADMIN },
                    { campus_id: campusId },
                  ],
                },
              ]
            : []),
        ],
      },
      select: { id: true },
    });

    const userIds = [...new Set(users.map((u) => u.id))];
    if (userIds.length === 0) return;

    const dateLabel = startDate.toISOString().slice(0, 10);
    await this.fcmService.sendToUsers(
      userIds,
      'New leave request',
      `${employeeName} submitted ${leaveTypeName} starting ${dateLabel}`,
      { type: 'leave_request', date: dateLabel },
    );
  }
}
