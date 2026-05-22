import { Injectable, NotFoundException } from '@nestjs/common';
import { PostdatedChequeStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export class CreatePostdatedChequeDto {
  student_id: number;
  cheque_number: string;
  bank_name?: string;
  amount: number;
  cheque_date: string;
  received_date: string;
  received_by: string;
  notes?: string;
}

export class ListPostdatedChequesFilter {
  status?: PostdatedChequeStatus;
  student_id?: number;
  campus_id?: number;
  from_date?: string;
  to_date?: string;
}

export class UpdateStatusDto {
  status: PostdatedChequeStatus;
  cashed_by?: string;
  cashed_date?: string;
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
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePostdatedChequeDto) {
    return this.prisma.postdated_cheques.create({
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
  }

  async list(filters: ListPostdatedChequesFilter) {
    const where: any = {};

    if (filters.status) where.status = filters.status;
    if (filters.student_id) where.student_id = filters.student_id;
    if (filters.campus_id) where.students = { campus_id: filters.campus_id };

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

  async getDue() {
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    return this.prisma.postdated_cheques.findMany({
      where: {
        status: PostdatedChequeStatus.PENDING,
        cheque_date: { lte: today },
      },
      select: CHEQUE_SELECT,
      orderBy: { cheque_date: 'asc' },
    });
  }

  async getByStudent(cc: number) {
    return this.prisma.postdated_cheques.findMany({
      where: { student_id: cc },
      select: CHEQUE_SELECT,
      orderBy: { cheque_date: 'asc' },
    });
  }

  async findOne(id: number) {
    const cheque = await this.prisma.postdated_cheques.findUnique({
      where: { id },
      select: CHEQUE_SELECT,
    });
    if (!cheque) throw new NotFoundException(`Cheque #${id} not found`);
    return cheque;
  }

  async updateStatus(id: number, dto: UpdateStatusDto) {
    await this.findOne(id);

    const data: any = { status: dto.status };
    if (dto.notes !== undefined) data.notes = dto.notes;

    if (dto.status === PostdatedChequeStatus.CASHED) {
      data.cashed_by = dto.cashed_by ?? null;
      data.cashed_date = dto.cashed_date ? new Date(dto.cashed_date) : new Date();
    }

    return this.prisma.postdated_cheques.update({
      where: { id },
      data,
      select: CHEQUE_SELECT,
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.postdated_cheques.delete({ where: { id } });
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
