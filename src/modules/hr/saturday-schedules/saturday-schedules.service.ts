import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { StaffCategory, StaffRole } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { FcmService } from '../../../common/fcm/fcm.service';
import { EmployeeNoticeBoardService } from '../../employee-notice-board/employee-notice-board.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { CreateSaturdayScheduleDto, ListSaturdaySchedulesQueryDto } from './dto/saturday-schedules.dto';

@Injectable()
export class SaturdaySchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly noticeBoard: EmployeeNoticeBoardService,
    private readonly fcmService: FcmService,
  ) {}

  async create(dto: CreateSaturdayScheduleDto, user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);

    const date = this.parseDate(dto.date);
    if (date.getUTCDay() !== 6) {
      throw new BadRequestException('Only Saturdays can be scheduled');
    }

    this.assertBeforePriorMonthCutoff(date);

    const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));

    const count = await this.prisma.teacher_saturday_schedules.count({
      where: {
        campus_id: dto.campusId,
        date: { gte: monthStart, lte: monthEnd },
      },
    });
    if (count >= 2) {
      throw new BadRequestException('Maximum two mandatory Saturdays per campus per month');
    }

    const campus = await this.prisma.campuses.findUnique({
      where: { id: dto.campusId },
      select: { campus_name: true },
    });
    if (!campus) throw new NotFoundException('Campus not found');

    const schedule = await this.prisma.teacher_saturday_schedules.create({
      data: {
        campus_id: dto.campusId,
        date,
        marked_by: user.sub,
      },
      include: {
        campuses: { select: { id: true, campus_name: true } },
        users: { select: { id: true, full_name: true } },
      },
    });

    const dateLabel = date.toISOString().slice(0, 10);
    void this.noticeBoard.createPost(
      {
        body: `Mandatory Saturday: ${dateLabel} at ${campus.campus_name}. Attendance is required for teachers.`,
        target_roles: [StaffRole.TEACHER],
        campus_ids: [dto.campusId],
      },
      user,
    );

    void this.notifyTeachers(dto.campusId, dateLabel);
    return schedule;
  }

  async list(query: ListSaturdaySchedulesQueryDto, user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);

    const [year, month] = query.month.split('-').map((v) => parseInt(v, 10));
    if (!year || !month || month < 1 || month > 12) {
      throw new BadRequestException('month must be YYYY-MM');
    }

    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 0));

    return this.prisma.teacher_saturday_schedules.findMany({
      where: {
        campus_id: query.campusId,
        date: { gte: monthStart, lte: monthEnd },
      },
      include: {
        campuses: { select: { id: true, campus_name: true } },
        users: { select: { id: true, full_name: true } },
      },
      orderBy: { date: 'asc' },
    });
  }

  async remove(id: number, user: IJwtStaffPayload) {
    this.assertSuperAdmin(user);

    const existing = await this.prisma.teacher_saturday_schedules.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Saturday schedule not found');

    this.assertBeforePriorMonthCutoff(existing.date);
    await this.prisma.teacher_saturday_schedules.delete({ where: { id } });
    return { id };
  }

  private assertSuperAdmin(user: IJwtStaffPayload) {
    if (user.role !== StaffRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only super admins can manage Saturday schedules');
    }
  }

  private parseDate(dateStr: string): Date {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Invalid date');
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private assertBeforePriorMonthCutoff(scheduleDate: Date, now = new Date()) {
    const year = scheduleDate.getUTCFullYear();
    const month = scheduleDate.getUTCMonth();
    const priorMonth = month === 0 ? 11 : month - 1;
    const priorYear = month === 0 ? year - 1 : year;
    const cutoff = new Date(Date.UTC(priorYear, priorMonth, 26));
    if (now >= cutoff) {
      throw new BadRequestException(
        'Saturday schedules must be marked before the 26th of the prior month',
      );
    }
  }

  private async notifyTeachers(campusId: number, dateLabel: string) {
    const teachers = await this.prisma.users.findMany({
      where: {
        is_active: true,
        deleted_at: null,
        campus_id: campusId,
        OR: [
          { role: StaffRole.TEACHER },
          {
            employee_profile: {
              staff_category: {
                in: [StaffCategory.TEACHER, StaffCategory.ASSISTANT_TEACHER],
              },
            },
          },
        ],
      },
      select: { id: true },
    });
    const userIds = teachers.map((t) => t.id);
    if (userIds.length === 0) return;

    await this.fcmService.sendToUsers(
      userIds,
      'Mandatory Saturday scheduled',
      `Attendance is required on ${dateLabel}`,
      { type: 'saturday_schedule', date: dateLabel },
    );
  }
}
