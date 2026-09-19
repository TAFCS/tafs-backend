import { Injectable, NotFoundException } from '@nestjs/common';
import { PostdatedChequeStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ScopeService } from '../../common/scope/scope.service';
import { applyStudentScope } from '../../common/staff-scope';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { IsNotEmpty, IsString, IsOptional, IsNumber, IsInt, IsEnum } from 'class-validator';

export class CreatePostdatedChequeDto {
  @IsNotEmpty()
  @IsInt()
  student_id: number;

  @IsNotEmpty()
  @IsString()
  cheque_number: string;

  @IsOptional()
  @IsString()
  bank_name?: string;

  @IsNotEmpty()
  @IsNumber()
  amount: number;

  @IsNotEmpty()
  @IsString()
  cheque_date: string;

  @IsNotEmpty()
  @IsString()
  received_date: string;

  @IsOptional()
  @IsString()
  received_by?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class ListPostdatedChequesFilter {
  status?: PostdatedChequeStatus | PostdatedChequeStatus[];
  student_id?: number;
  campus_id?: number | number[];
  from_date?: string;
  to_date?: string;
}

export class UpdateStatusDto {
  @IsNotEmpty()
  @IsEnum(PostdatedChequeStatus)
  status: PostdatedChequeStatus;

  @IsOptional()
  @IsString()
  cashed_by?: string;

  @IsOptional()
  @IsString()
  cashed_date?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

const CHEQUE_SELECT = {
  id: true,
  cheque_number: true,
  bank_name: true,
  amount: true,
  cheque_date: true,
  received_date: true,
  received_by: true,
  status: true,
  cashed_date: true,
  cashed_by: true,
  notes: true,
  created_at: true,
  students: { select: { cc: true, full_name: true, campus_id: true } },
  received_by_user: { select: { id: true, full_name: true } },
  cashed_by_user: { select: { id: true, full_name: true } },
};

@Injectable()
export class PostdatedChequesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * The caller's data scope, expressed against the cheque's student. Universal
   * scope AND the legacy campus/class fields (tokens issued before universal
   * scope still carry them), never one replacing the other. `user` omitted
   * means an internal caller and applies no filter.
   */
  private studentsFilter(user?: IJwtStaffPayload): Prisma.studentsWhereInput {
    if (!user) return {};
    return { AND: [this.scope.whereForStudents(user), applyStudentScope(user, {})] };
  }

  async create(dto: CreatePostdatedChequeDto, changedBy?: string, user?: IJwtStaffPayload) {
    // Missing and out-of-scope both 404: a 403 would confirm a student exists
    // at a campus the caller cannot see.
    if (user) {
      const visible = await this.prisma.students.findFirst({
        where: { AND: [{ cc: dto.student_id }, this.studentsFilter(user)] },
        select: { cc: true },
      });
      if (!visible) throw new NotFoundException(`Student #${dto.student_id} not found`);
    }
    const record = await this.prisma.postdated_cheques.create({
      data: {
        student_id: dto.student_id,
        cheque_number: dto.cheque_number,
        bank_name: dto.bank_name,
        amount: dto.amount,
        cheque_date: new Date(dto.cheque_date),
        received_date: new Date(dto.received_date),
        received_by: dto.received_by,
        notes: dto.notes,
      },
      select: CHEQUE_SELECT,
    });
    this.auditLogs.log({
      entity_type: 'CHEQUE',
      entity_id: String(record.id),
      action: 'CREATED',
      section: 'finance',
      new_value: `cheque#${dto.cheque_number}, amount=${dto.amount}, date=${dto.cheque_date}`,
      changed_by: changedBy ?? dto.received_by ?? 'system',
      student_id: dto.student_id,
    });
    return record;
  }

  async list(filters: ListPostdatedChequesFilter, user?: IJwtStaffPayload) {
    const where: any = {};
    const studentClauses: Prisma.studentsWhereInput[] = [this.studentsFilter(user)];

    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
    }
    if (filters.student_id) where.student_id = filters.student_id;
    if (filters.campus_id != null) {
      const campusIds = Array.isArray(filters.campus_id) ? filters.campus_id : [filters.campus_id];
      studentClauses.push({
        campus_id: campusIds.length === 1 ? campusIds[0] : { in: campusIds },
      });
    }
    where.students = { AND: studentClauses };

    if (filters.from_date || filters.to_date) {
      where.cheque_date = {};
      if (filters.from_date) where.cheque_date.gte = new Date(filters.from_date);
      if (filters.to_date) where.cheque_date.lte = new Date(filters.to_date);
    }

    return this.prisma.postdated_cheques.findMany({
      where,
      select: CHEQUE_SELECT,
      orderBy: { cheque_date: 'asc' },
    });
  }

  async getDue(user?: IJwtStaffPayload) {
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    return this.prisma.postdated_cheques.findMany({
      where: {
        status: PostdatedChequeStatus.PENDING,
        cheque_date: { lte: today },
        students: this.studentsFilter(user),
      },
      select: CHEQUE_SELECT,
      orderBy: { cheque_date: 'asc' },
    });
  }

  async getByStudent(cc: number, user?: IJwtStaffPayload) {
    return this.prisma.postdated_cheques.findMany({
      where: { student_id: cc, students: this.studentsFilter(user) },
      select: CHEQUE_SELECT,
      orderBy: { cheque_date: 'asc' },
    });
  }

  async findOne(id: number, user?: IJwtStaffPayload) {
    const cheque = await this.prisma.postdated_cheques.findFirst({
      where: { id, students: this.studentsFilter(user) },
      select: CHEQUE_SELECT,
    });
    if (!cheque) throw new NotFoundException(`Cheque #${id} not found`);
    return cheque;
  }

  async updateStatus(id: number, dto: UpdateStatusDto, changedBy?: string, user?: IJwtStaffPayload) {
    const existing = await this.findOne(id, user);

    const data: any = { status: dto.status };
    if (dto.notes !== undefined) data.notes = dto.notes;

    if (dto.status === PostdatedChequeStatus.CASHED) {
      data.cashed_by = dto.cashed_by ?? null;
      data.cashed_date = dto.cashed_date ? new Date(dto.cashed_date) : new Date();
    }

    const record = await this.prisma.postdated_cheques.update({
      where: { id },
      data,
      select: CHEQUE_SELECT,
    });
    this.auditLogs.log({
      entity_type: 'CHEQUE',
      entity_id: String(id),
      action: 'STATUS_CHANGED',
      section: 'finance',
      field: 'status',
      old_value: (existing as any).status,
      new_value: dto.status,
      changed_by: changedBy ?? 'system',
      student_id: (existing as any).students?.cc,
    });
    return record;
  }

  async remove(id: number, changedBy?: string, user?: IJwtStaffPayload) {
    const existing = await this.findOne(id, user);
    const record = await this.prisma.postdated_cheques.delete({ where: { id } });
    this.auditLogs.log({
      entity_type: 'CHEQUE',
      entity_id: String(id),
      action: 'DELETED',
      section: 'finance',
      changed_by: changedBy ?? 'system',
      student_id: (existing as any).students?.cc,
    });
    return record;
  }

  async getDashboardSummary() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const in7Days = new Date(todayEnd);
    in7Days.setDate(in7Days.getDate() + 7);

    const [overdueCount, dueTodayResult, upcomingCount] = await Promise.all([
      this.prisma.postdated_cheques.count({
        where: {
          status: PostdatedChequeStatus.PENDING,
          cheque_date: { lt: todayStart },
        },
      }),
      this.prisma.postdated_cheques.aggregate({
        where: {
          status: PostdatedChequeStatus.PENDING,
          cheque_date: { gte: todayStart, lte: todayEnd },
        },
        _count: { id: true },
        _sum: { amount: true },
      }),
      this.prisma.postdated_cheques.count({
        where: {
          status: PostdatedChequeStatus.PENDING,
          cheque_date: { gt: todayEnd, lte: in7Days },
        },
      }),
    ]);

    return {
      overdue_count: overdueCount,
      due_today_count: dueTodayResult._count.id,
      due_today_total_amount: Number(dueTodayResult._sum.amount ?? 0),
      due_in_7_days_count: upcomingCount,
    };
  }
}
