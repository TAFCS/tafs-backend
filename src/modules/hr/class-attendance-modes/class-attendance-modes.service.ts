import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';

export class SetClassAttendanceModeDto {
  class_id: number;
  mode: string; // 'BIOMETRIC_DAILY' | 'ROLL_CALL_SESSION'
}

@Injectable()
export class ClassAttendanceModesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async findAll() {
    return this.prisma.class_attendance_modes.findMany({
      include: {
        classes: { select: { description: true, class_code: true } }
      }
    });
  }

  async findOneByClass(classId: number) {
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

  async setMode(dto: SetClassAttendanceModeDto, changedBy: string) {
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

  async remove(classId: number, changedBy: string) {
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
