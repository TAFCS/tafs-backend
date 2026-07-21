import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { device_user_mappings, DevicePersonType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ZkAttendanceProcessorService } from './zk-attendance-processor.service';
import { CreateDeviceMappingDto, SimulateScanDto, UpdateDeviceMappingDto } from './dto/zk-attendance.dto';

@Injectable()
export class ZkAttendanceMappingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: ZkAttendanceProcessorService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async getMappings(employeeId?: number) {
    return this.prisma.device_user_mappings.findMany({
      where: employeeId != null ? { employee_id: employeeId } : undefined,
      orderBy: [{ device_sn: 'asc' }, { device_pin: 'asc' }],
      include: {
        employee_profiles: { select: { id: true, full_name: true, employee_code: true } },
        students: { select: { cc: true, full_name: true, gr_number: true } },
      },
    });
  }

  async createMapping(dto: CreateDeviceMappingDto, userId: string) {
    this.validatePersonRefs(dto.person_type, dto.employee_id, dto.student_cc);

    const before = await this.prisma.device_user_mappings.findUnique({
      where: { device_sn_device_pin: { device_sn: dto.device_sn, device_pin: dto.device_pin } },
    });

    const mapping = await this.prisma.device_user_mappings.upsert({
      where: { device_sn_device_pin: { device_sn: dto.device_sn, device_pin: dto.device_pin } },
      create: {
        device_sn: dto.device_sn,
        device_pin: dto.device_pin,
        person_type: dto.person_type,
        employee_id: dto.person_type === DevicePersonType.STAFF ? dto.employee_id : null,
        student_cc: dto.person_type === DevicePersonType.STUDENT ? dto.student_cc : null,
        display_name: dto.display_name,
        notes: dto.notes,
        created_by: userId,
      },
      update: {
        person_type: dto.person_type,
        employee_id: dto.person_type === DevicePersonType.STAFF ? dto.employee_id : null,
        student_cc: dto.person_type === DevicePersonType.STUDENT ? dto.student_cc : null,
        display_name: dto.display_name,
        notes: dto.notes,
        is_active: true,
      },
    });

    const personRef =
      mapping.person_type === DevicePersonType.STAFF
        ? `employee #${mapping.employee_id}`
        : `student #${mapping.student_cc}`;

    await this.auditLogs.log({
      entity_type: 'ZK_ATTENDANCE_MAPPING',
      entity_id: String(mapping.id),
      action: before ? 'UPDATED' : 'CREATED',
      changed_by: userId,
      student_id: mapping.student_cc ?? null,
      note: before
        ? `Device mapping #${mapping.id} upserted for ${mapping.device_sn}/${mapping.device_pin} → ${personRef}` +
          (mapping.display_name ? ` ("${mapping.display_name}")` : '') + '.'
        : `Device mapping #${mapping.id} created: ${mapping.device_sn}/${mapping.device_pin} → ${personRef}` +
          (mapping.display_name ? ` ("${mapping.display_name}")` : '') + '.',
    });

    await this.reprocessOrphanScans(mapping);

    return mapping;
  }

  async updateMapping(id: number, dto: UpdateDeviceMappingDto, changedBy?: string) {
    const existing = await this.prisma.device_user_mappings.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Mapping not found');

    const personType = dto.person_type ?? existing.person_type;
    if (dto.person_type || dto.employee_id !== undefined || dto.student_cc !== undefined) {
      this.validatePersonRefs(
        personType,
        dto.employee_id ?? existing.employee_id ?? undefined,
        dto.student_cc ?? existing.student_cc ?? undefined,
      );
    }

    const updated = await this.prisma.device_user_mappings.update({
      where: { id },
      data: {
        person_type: dto.person_type,
        employee_id: personType === DevicePersonType.STAFF ? (dto.employee_id ?? existing.employee_id) : null,
        student_cc: personType === DevicePersonType.STUDENT ? (dto.student_cc ?? existing.student_cc) : null,
        display_name: dto.display_name,
        notes: dto.notes,
        is_active: dto.is_active,
      },
    });

    const changes: string[] = [];
    if (existing.person_type !== updated.person_type) {
      changes.push(`person_type ${existing.person_type} → ${updated.person_type}`);
    }
    if ((existing.employee_id ?? null) !== (updated.employee_id ?? null)) {
      changes.push(`employee_id ${existing.employee_id ?? '—'} → ${updated.employee_id ?? '—'}`);
    }
    if ((existing.student_cc ?? null) !== (updated.student_cc ?? null)) {
      changes.push(`student_cc ${existing.student_cc ?? '—'} → ${updated.student_cc ?? '—'}`);
    }
    if ((existing.display_name ?? null) !== (updated.display_name ?? null)) {
      changes.push(`display_name "${existing.display_name ?? '—'}" → "${updated.display_name ?? '—'}"`);
    }
    if (existing.is_active !== updated.is_active) {
      changes.push(`is_active ${existing.is_active} → ${updated.is_active}`);
    }

    if (changes.length > 0) {
      await this.auditLogs.log({
        entity_type: 'ZK_ATTENDANCE_MAPPING',
        entity_id: String(id),
        action: 'UPDATED',
        changed_by: changedBy ?? 'system',
        student_id: updated.student_cc ?? null,
        note: `Device mapping #${id} (${existing.device_sn}/${existing.device_pin}) updated: ${changes.join(', ')}.`,
      });
    }

    if (updated.is_active) {
      await this.reprocessOrphanScans(updated);
    }

    return updated;
  }

  async getUnmappedPins() {
    const groups = await this.prisma.zk_attendance_scans.groupBy({
      by: ['device_sn', 'device_pin'],
      where: { person_type: null },
      _count: { _all: true },
      _min: { scan_time: true },
      _max: { scan_time: true },
      orderBy: { _max: { scan_time: 'desc' } },
    });

    if (groups.length === 0) return [];

    const hints = await this.prisma.zk_pin_name_hints.findMany({
      where: { OR: groups.map((g) => ({ device_sn: g.device_sn, device_pin: g.device_pin })) },
    });
    const hintMap = new Map(hints.map((h) => [`${h.device_sn}:${h.device_pin}`, h.suggested_name]));

    return groups.map((g) => ({
      device_sn: g.device_sn,
      device_pin: g.device_pin,
      scan_count: g._count._all,
      first_seen: g._min.scan_time,
      last_seen: g._max.scan_time,
      suggested_name: hintMap.get(`${g.device_sn}:${g.device_pin}`) ?? null,
    }));
  }

  // Builds a synthetic ATTLOG line and feeds it through the same processPush()
  // path a real device push uses — for dev/testing without physical hardware.
  async simulateScan(dto: SimulateScanDto, changedBy?: string) {
    const scanTime = dto.scan_time ? new Date(dto.scan_time) : new Date();
    const line = `${dto.device_pin}\t${this.formatDeviceDateTime(scanTime)}\t1\t1\t0`;

    const processResults = await this.processor.processPush(
      {
        sn: dto.device_sn,
        query: { table: 'ATTLOG' },
        body: line,
        pushLogId: null,
      },
      { forceNotify: true },
    );

    const scan = await this.prisma.zk_attendance_scans.findFirst({
      where: { device_sn: dto.device_sn, device_pin: dto.device_pin },
      orderBy: { id: 'desc' },
    });

    let record: unknown = null;
    if (scan?.person_type === DevicePersonType.STAFF && scan.employee_id) {
      record = await this.prisma.attendance_staff_daily.findUnique({
        where: { employee_id_date: { employee_id: scan.employee_id, date: scan.attendance_date } },
      });
    } else if (scan?.person_type === DevicePersonType.STUDENT && scan.student_cc) {
      record = await this.prisma.attendance_student_daily.findUnique({
        where: { student_cc_date: { student_cc: scan.student_cc, date: scan.attendance_date } },
      });
    }

    const lastResult = processResults[processResults.length - 1];

    await this.auditLogs.log({
      entity_type: scan?.person_type === DevicePersonType.STAFF ? 'STAFF_ATTENDANCE' : 'STUDENT_ATTENDANCE',
      entity_id: scan ? String(scan.id) : `${dto.device_sn}:${dto.device_pin}`,
      action: 'CREATED',
      changed_by: changedBy ?? 'system',
      student_id: scan?.student_cc ?? null,
      note: `Simulated scan on ${dto.device_sn}/${dto.device_pin} at ${scanTime.toISOString()}` +
        (scan?.person_type ? ` → ${scan.person_type}` : ' (unmapped)') +
        (lastResult?.notified ? ', notified' : lastResult?.skipReason ? `, skipped: ${lastResult.skipReason}` : '') + '.',
    });

    return {
      scan,
      record,
      notified: lastResult?.notified ?? false,
      skip_reason: lastResult?.notified ? null : (lastResult?.skipReason ?? null),
    };
  }

  // "YYYY-MM-DD HH:MM:SS" — same naive device wall-clock format ZkAttendanceProcessorService parses.
  // Real devices report Pakistan local time (Asia/Karachi, UTC+5, no DST), so convert
  // the given instant to that timezone's wall-clock components before formatting.
  private formatDeviceDateTime(d: Date): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Karachi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .reduce<Record<string, string>>((acc, p) => {
        acc[p.type] = p.value;
        return acc;
      }, {});

    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  private validatePersonRefs(personType: DevicePersonType, employeeId?: number | null, studentCc?: number | null) {
    if (personType === DevicePersonType.STAFF && !employeeId) {
      throw new BadRequestException('employee_id is required for STAFF mappings');
    }
    if (personType === DevicePersonType.STUDENT && !studentCc) {
      throw new BadRequestException('student_cc is required for STUDENT mappings');
    }
  }

  // Newly (re)mapped PINs may already have orphaned scans recorded with
  // person_type=null — attach them and recompute affected days so the
  // person's attendance reflects history captured before mapping existed.
  private async reprocessOrphanScans(mapping: device_user_mappings) {
    const orphans = await this.prisma.zk_attendance_scans.findMany({
      where: { device_sn: mapping.device_sn, device_pin: mapping.device_pin, person_type: null },
      select: { id: true, attendance_date: true },
    });
    if (orphans.length === 0) return;

    await this.prisma.zk_attendance_scans.updateMany({
      where: { id: { in: orphans.map((o) => o.id) } },
      data: {
        person_type: mapping.person_type,
        employee_id: mapping.employee_id ?? undefined,
        student_cc: mapping.student_cc ?? undefined,
      },
    });

    const dates = [...new Set(orphans.map((o) => o.attendance_date.toISOString()))].map((s) => new Date(s));

    for (const date of dates) {
      const seg = await this.processor.recomputeDaySequence(
        mapping.person_type,
        mapping.employee_id,
        mapping.student_cc,
        date,
      );
      if (mapping.person_type === DevicePersonType.STAFF) {
        await this.processor.upsertStaffDaily(mapping.employee_id!, date, seg);
      } else {
        await this.processor.upsertStudentDaily(mapping.student_cc!, date, seg);
      }
    }
  }
}
