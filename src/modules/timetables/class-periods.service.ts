import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { assertClassInScope } from '../../common/staff-scope';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { UpsertClassPeriodDto } from './dto/timetables.dto';

export type ResolvedPeriod = {
  start_time: Date;
  end_time: Date;
  label: string | null;
  is_break: boolean;
};

@Injectable()
export class ClassPeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private parseTime(value: string): Date {
    const parts = value.split(':').map((p) => parseInt(p, 10));
    const h = parts[0];
    const m = parts[1] ?? 0;
    if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
      throw new BadRequestException('Invalid time format, expected HH:MM');
    }
    return new Date(Date.UTC(1970, 0, 1, h, m, 0));
  }

  async list(campusId: number, classId: number) {
    return this.prisma.class_timetable_periods.findMany({
      where: { campus_id: campusId, class_id: classId },
      orderBy: { block_number: 'asc' },
    });
  }

  async upsert(dto: UpsertClassPeriodDto, user: IJwtStaffPayload) {
    assertClassInScope(user, dto.class_id);

    const start = this.parseTime(dto.start_time);
    const end = this.parseTime(dto.end_time);
    if (end.getTime() <= start.getTime()) {
      throw new BadRequestException('End time must be after start time');
    }

    const result = await this.prisma.class_timetable_periods.upsert({
      where: {
        campus_id_class_id_block_number: {
          campus_id: dto.campus_id,
          class_id: dto.class_id,
          block_number: dto.block_number,
        },
      },
      create: {
        campus_id: dto.campus_id,
        class_id: dto.class_id,
        block_number: dto.block_number,
        start_time: start,
        end_time: end,
        is_break: dto.is_break ?? false,
        label: dto.label?.trim() || null,
      },
      update: {
        start_time: start,
        end_time: end,
        is_break: dto.is_break ?? false,
        label: dto.label?.trim() || null,
      },
    });

    void this.auditLogs.log({
      entity_type: 'CLASS_TIMETABLE_PERIOD',
      entity_id: String(result.id),
      action: 'UPSERTED',
      changed_by: auditActorLabel(user),
      note: `Period ${dto.block_number} for campus #${dto.campus_id}, class #${dto.class_id}: ${dto.start_time}–${dto.end_time}${dto.is_break ? ' (break)' : ''}.`,
    });

    return result;
  }

  async remove(id: number, user: IJwtStaffPayload) {
    const existing = await this.prisma.class_timetable_periods.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Period not found');
    assertClassInScope(user, existing.class_id);

    await this.prisma.class_timetable_periods.delete({ where: { id } });

    void this.auditLogs.log({
      entity_type: 'CLASS_TIMETABLE_PERIOD',
      entity_id: String(id),
      action: 'DELETED',
      changed_by: auditActorLabel(user),
      note: `Period ${existing.block_number} for campus #${existing.campus_id}, class #${existing.class_id} deleted.`,
    });

    return { deleted: true };
  }

  /**
   * Batched lookup for consumers resolving times across many (campus, class,
   * block) tuples at once -- payroll derivation and merged multi-class
   * weekly views, where a single teacher/student's slots can span classes
   * that each run their own bell schedule.
   */
  async resolveMany(
    scopes: { campus_id: number; class_id: number; block_number: number }[],
  ): Promise<Map<string, ResolvedPeriod>> {
    const map = new Map<string, ResolvedPeriod>();
    if (scopes.length === 0) return map;

    const pairKeys = new Set(scopes.map((s) => `${s.campus_id}:${s.class_id}`));
    const pairs = [...pairKeys].map((key) => {
      const [campus_id, class_id] = key.split(':').map(Number);
      return { campus_id, class_id };
    });

    const rows = await this.prisma.class_timetable_periods.findMany({
      where: { OR: pairs },
    });

    for (const row of rows) {
      map.set(`${row.campus_id}:${row.class_id}:${row.block_number}`, {
        start_time: row.start_time,
        end_time: row.end_time,
        label: row.label,
        is_break: row.is_break,
      });
    }
    return map;
  }
}
