import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { BulkMarkStaffAttendanceDto, GetStaffAttendanceQueryDto } from './dto/staff-attendance.dto';

@Injectable()
export class StaffAttendanceService {
  constructor(private readonly prisma: PrismaService) {}

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

  async getRegister(query: GetStaffAttendanceQueryDto, user: IJwtStaffPayload) {
    const date = this.parseDate(query.date);

    // Determine effective campus: caller-scoped or explicit
    const campusId = query.campus_id ?? user.campusId ?? undefined;
    if (!campusId) throw new BadRequestException('campus_id is required');
    this.assertCampusAccess(user, campusId);

    // Fetch employees whose linked user belongs to this campus
    const employees = await this.prisma.employee_profiles.findMany({
      where: {
        users: { campus_id: campusId, is_active: true, deleted_at: null },
        ...(query.department_id ? { department_id: query.department_id } : {}),
      },
      include: {
        users: { select: { id: true, full_name: true, role: true, email: true } },
        departments: { select: { id: true, name: true } },
        designations: { select: { id: true, title: true } },
      },
      orderBy: [{ departments: { name: 'asc' } }, { id: 'asc' }],
    });

    if (employees.length === 0) return [];

    // Fetch existing attendance records for the date
    const employeeIds = employees.map((e) => e.id);
    const records = await this.prisma.attendance_staff_daily.findMany({
      where: { date, employee_id: { in: employeeIds } },
    });

    const recordMap = new Map(records.map((r) => [r.employee_id, r]));

    return employees.map((emp) => ({
      employee: emp,
      record: recordMap.get(emp.id) ?? null,
    }));
  }

  async bulkMark(dto: BulkMarkStaffAttendanceDto, user: IJwtStaffPayload) {
    this.assertCampusAccess(user, dto.campus_id);

    const date = this.parseDate(dto.date);

    // Validate all employee IDs belong to this campus
    const employeeIds = dto.records.map((r) => r.employee_id);
    const employees = await this.prisma.employee_profiles.findMany({
      where: {
        id: { in: employeeIds },
        users: { campus_id: dto.campus_id },
      },
      select: { id: true },
    });

    const validIds = new Set(employees.map((e) => e.id));
    const invalid = employeeIds.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Employee IDs not found on this campus: ${invalid.join(', ')}`,
      );
    }

    // Upsert all records in a transaction
    const upserts = dto.records.map((mark) =>
      this.prisma.attendance_staff_daily.upsert({
        where: { employee_id_date: { employee_id: mark.employee_id, date } },
        create: {
          employee_id: mark.employee_id,
          campus_id: dto.campus_id,
          date,
          status: mark.status,
          notes: mark.notes ?? null,
          marked_by: user.sub,
        },
        update: {
          status: mark.status,
          notes: mark.notes ?? null,
          marked_by: user.sub,
        },
      }),
    );

    await this.prisma.$transaction(upserts);

    // Return refreshed register
    return this.getRegister(
      { date: dto.date, campus_id: dto.campus_id },
      user,
    );
  }
}
