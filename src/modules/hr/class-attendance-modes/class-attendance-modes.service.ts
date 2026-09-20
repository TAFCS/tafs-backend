import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { ScopeService } from '../../../common/scope/scope.service';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';

export class SetClassAttendanceModeDto {
  class_id: number;
  mode: string; // 'BIOMETRIC_DAILY' | 'ROLL_CALL_SESSION'
}

@Injectable()
export class ClassAttendanceModesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly scope: ScopeService,
  ) {}

  /** Class ids the caller is limited to; undefined means unrestricted (or an internal caller). */
  private allowedClassIds(user?: IJwtStaffPayload): number[] | undefined {
    if (!user || this.scope.isExempt(user)) return undefined;
    const classes = this.scope.scopeOf(user).classes;
    return classes.length > 0 ? classes : undefined;
  }

  async findAll(user?: IJwtStaffPayload) {
    const allowed = this.allowedClassIds(user);
    return this.prisma.class_attendance_modes.findMany({
      ...(allowed ? { where: { class_id: { in: allowed } } } : {}),
      include: {
        classes: { select: { description: true, class_code: true } }
      }
    });
  }

  async findOneByClass(classId: number, user?: IJwtStaffPayload) {
    const allowed = this.allowedClassIds(user);
    // A class outside the caller's scope 404s, same as a missing one.
    if (allowed && !allowed.includes(classId)) {
      throw new NotFoundException(`Attendance mode for class ID ${classId} not found`);
    }
    const mode = await this.prisma.class_attendance_modes.findUnique({
      where: { class_id: classId },
      include: {
        classes: { select: { description: true, class_code: true } }
      }
    });
    if (!mode) {
      throw new NotFoundException(`Attendance mode for class ID ${classId} not found`);
    }
    return mode;
  }

  async setMode(dto: SetClassAttendanceModeDto, changedBy: string, user?: IJwtStaffPayload) {
    if (user) this.scope.assertClass(user, dto.class_id);
    const existing = await this.prisma.class_attendance_modes.findUnique({
      where: { class_id: dto.class_id },
    });
    const result = await this.prisma.class_attendance_modes.upsert({
      where: { class_id: dto.class_id },
      update: { mode: dto.mode },
      create: { class_id: dto.class_id, mode: dto.mode },
      include: { classes: { select: { description: true, class_code: true } } },
    });

    const classLabel = result.classes?.description ?? result.classes?.class_code ?? `Class #${dto.class_id}`;
    void this.auditLogs.log({
      entity_type: 'CLASS_ATTENDANCE_MODE',
      entity_id: String(dto.class_id),
      action: existing ? 'UPDATED' : 'CREATED',
      field: 'mode',
      old_value: existing?.mode ?? null,
      new_value: dto.mode,
      changed_by: changedBy,
      note: `Attendance mode for ${classLabel} set to ${dto.mode}.`,
    });

    return result;
  }

  async remove(classId: number, changedBy: string, user?: IJwtStaffPayload) {
    if (user) this.scope.assertClass(user, classId);
    const existing = await this.findOneByClass(classId);
    const deleted = await this.prisma.class_attendance_modes.delete({
      where: { class_id: classId }
    });

    const classLabel = existing.classes?.description ?? existing.classes?.class_code ?? `Class #${classId}`;
    void this.auditLogs.log({
      entity_type: 'CLASS_ATTENDANCE_MODE',
      entity_id: String(classId),
      action: 'DELETED',
      changed_by: changedBy,
      note: `Removed attendance mode configuration (was ${existing.mode}) for ${classLabel}.`,
    });

    return deleted;
  }
}
