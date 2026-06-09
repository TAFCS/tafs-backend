import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { QueryAuditLogsDto } from './dto/query-audit-logs.dto';

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) { }

  /**
   * Log an event. This is fire-and-forget and safe.
   * If it fails, we catch the error to ensure user actions aren't blocked.
   */
  async log(params: {
    entity_type: string;
    entity_id: string;
    action: string;
    field?: string | null;
    old_value?: string | null;
    new_value?: string | null;
    changed_by: string;
    student_id?: number | null;
    note?: string | null;
  }) {
    try {
      await this.prisma.audit_logs.create({
        data: {
          entity_type: params.entity_type,
          entity_id: params.entity_id,
          action: params.action,
          field: params.field || null,
          old_value: params.old_value || null,
          new_value: params.new_value || null,
          changed_by: params.changed_by,
          student_id: params.student_id || null,
          note: params.note || null,
        },
      });
    } catch (err) {
      console.error('[AuditLog] Failed to write log entry:', err);
    }
  }

  /**
   * Find logs matching query criteria.
   */
  async findAll(query: QueryAuditLogsDto) {
    const where: any = {};

    if (query.student_id) {
      where.student_id = Number(query.student_id);
    }
    if (query.entity_type) {
      const types = query.entity_type.split(',').map((t) => t.trim()).filter(Boolean);
      if (types.length > 1) {
        where.entity_type = { in: types };
      } else if (types.length === 1) {
        where.entity_type = types[0];
      }
    }
    if (query.changed_by) {
      where.changed_by = { contains: query.changed_by, mode: 'insensitive' };
    }

    if (query.from || query.to) {
      where.changed_at = {};
      if (query.from) {
        where.changed_at.gte = new Date(query.from);
      }
      if (query.to) {
        where.changed_at.lte = new Date(query.to);
      }
    }

    const limit = Number(query.limit) || 50;
    const offset = Number(query.offset) || 0;

    const [data, total] = await Promise.all([
      this.prisma.audit_logs.findMany({
        where,
        orderBy: { changed_at: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.audit_logs.count({ where }),
    ]);

    return { data, total };
  }
}
