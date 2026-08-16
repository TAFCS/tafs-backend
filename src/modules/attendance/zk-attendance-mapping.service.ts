import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { device_user_mappings, DevicePersonType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ZkAttendanceProcessorService } from './zk-attendance-processor.service';
import { ZkScanResolutionService, ResolutionReport } from './zk-scan-resolution.service';
import { CreateDeviceMappingDto, SimulateScanDto, UpdateDeviceMappingDto } from './dto/zk-attendance.dto';

/**
 * Above this, re-attribution is too slow to run inside the HTTP request that
 * changed the mapping. The mapping edit still succeeds; the caller is told to
 * finish the job via POST /attendance/zk-scan-resolution/resolve.
 */
const INLINE_RESOLVE_SCAN_LIMIT = 2000;

export type CollisionSeverity = 'BLOCK' | 'WARN';

export interface PinCollision {
  code:
    | 'PIN_IS_OTHER_STUDENT_GR'
    | 'PIN_IS_OTHER_STUDENT_CC'
    | 'PIN_NOT_EQUAL_TO_CC'
    | 'PIN_USED_ON_OTHER_DEVICE';
  severity: CollisionSeverity;
  message: string;
  conflicting_student_cc?: number;
  conflicting_student_name?: string;
  conflicting_mapping_id?: number;
}

@Injectable()
export class ZkAttendanceMappingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: ZkAttendanceProcessorService,
    private readonly auditLogs: AuditLogsService,
    private readonly resolution: ZkScanResolutionService,
  ) {}

  async getMappings(employeeId?: number, studentCc?: number) {
    const where =
      employeeId != null ? { employee_id: employeeId } : studentCc != null ? { student_cc: studentCc } : undefined;
    return this.prisma.device_user_mappings.findMany({
      where,
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

    // This endpoint is an upsert, so POSTing over a deliberately deactivated
    // mapping used to silently revive it (and re-attach its history) with no
    // signal to the caller. Make reactivation explicit.
    if (before && !before.is_active && dto.is_active !== true) {
      throw new ConflictException(
        `Mapping #${before.id} for ${dto.device_sn}/${dto.device_pin} exists but is deactivated. ` +
          `Pass is_active: true to reactivate it, or PATCH the mapping directly.`,
      );
    }

    const collisions = await this.assertNoBlockingCollisions(
      {
        device_sn: dto.device_sn,
        device_pin: dto.device_pin,
        person_type: dto.person_type,
        employee_id: dto.employee_id,
        student_cc: dto.student_cc,
        exclude_mapping_id: before?.id,
      },
      dto.acknowledge_collisions,
    );

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

    const resolution = await this.resolvePin(mapping.device_sn, mapping.device_pin, userId);

    return { ...mapping, resolution, collisions };
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

    // Only re-check when the mapping is being pointed at a different person;
    // a plain is_active toggle shouldn't be blocked by a pre-existing collision.
    if (dto.person_type || dto.employee_id !== undefined || dto.student_cc !== undefined) {
      await this.assertNoBlockingCollisions(
        {
          device_sn: existing.device_sn,
          device_pin: existing.device_pin,
          person_type: personType,
          employee_id: dto.employee_id ?? existing.employee_id,
          student_cc: dto.student_cc ?? existing.student_cc,
          exclude_mapping_id: id,
        },
        dto.acknowledge_collisions,
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

    // Unconditional: deactivating is exactly the case that must RELEASE history.
    // The old `if (updated.is_active)` guard made deactivation forward-only,
    // so a student kept attendance from a pin that was no longer theirs.
    const resolution = await this.resolvePin(updated.device_sn, updated.device_pin, changedBy ?? 'system');

    return { ...updated, resolution };
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

  /**
   * Student GR numbers and CCs share one numeric namespace, so a pin taken from
   * a GR number can silently be another student's CC. That is exactly how pin
   * 6102 credited MUHAMMAD HAIB MIRZA's attendance to AIZA BAIG for two days.
   *
   * BLOCK = the pin provably identifies a different student.
   * WARN  = worth surfacing, but legitimate in some setups.
   */
  async checkPinCollisions(input: {
    device_sn: string;
    device_pin: string;
    person_type: DevicePersonType;
    employee_id?: number | null;
    student_cc?: number | null;
    exclude_mapping_id?: number;
  }): Promise<PinCollision[]> {
    const collisions: PinCollision[] = [];
    const pin = input.device_pin.trim();
    const pinAsNumber = /^\d+$/.test(pin) ? Number(pin) : null;

    const candidates = await this.prisma.students.findMany({
      where: {
        deleted_at: null,
        OR: [{ gr_number: pin }, ...(pinAsNumber !== null ? [{ cc: pinAsNumber }] : [])],
      },
      select: { cc: true, full_name: true, gr_number: true },
    });

    for (const s of candidates) {
      if (input.person_type === DevicePersonType.STUDENT && s.cc === input.student_cc) continue;

      const isCcMatch = s.cc === pinAsNumber;
      collisions.push({
        code: isCcMatch ? 'PIN_IS_OTHER_STUDENT_CC' : 'PIN_IS_OTHER_STUDENT_GR',
        severity: 'BLOCK',
        message:
          `Pin ${pin} is ${isCcMatch ? 'the CC' : `the GR number (${s.gr_number})`} of ` +
          `${s.full_name} (cc ${s.cc}). Using it here would credit their scans to the wrong person.`,
        conflicting_student_cc: s.cc,
        conflicting_student_name: s.full_name ?? undefined,
      });
    }

    // House convention (see scripts/check-student-device-mappings.ts) is pin == cc.
    if (
      input.person_type === DevicePersonType.STUDENT &&
      input.student_cc != null &&
      pinAsNumber !== null &&
      pinAsNumber !== input.student_cc
    ) {
      collisions.push({
        code: 'PIN_NOT_EQUAL_TO_CC',
        severity: 'WARN',
        message: `Pin ${pin} does not match this student's CC (${input.student_cc}). Convention is pin == cc.`,
      });
    }

    const otherDevice = await this.prisma.device_user_mappings.findFirst({
      where: {
        device_pin: pin,
        is_active: true,
        device_sn: { not: input.device_sn },
        ...(input.exclude_mapping_id ? { id: { not: input.exclude_mapping_id } } : {}),
      },
      select: { id: true, device_sn: true, employee_id: true, student_cc: true },
    });
    if (
      otherDevice &&
      (otherDevice.employee_id !== (input.employee_id ?? null) ||
        otherDevice.student_cc !== (input.student_cc ?? null))
    ) {
      collisions.push({
        code: 'PIN_USED_ON_OTHER_DEVICE',
        severity: 'WARN',
        message: `Pin ${pin} is already mapped to a different person on device ${otherDevice.device_sn}.`,
        conflicting_mapping_id: otherDevice.id,
      });
    }

    return collisions;
  }

  private async assertNoBlockingCollisions(
    input: Parameters<ZkAttendanceMappingService['checkPinCollisions']>[0],
    acknowledge?: boolean,
  ): Promise<PinCollision[]> {
    const collisions = await this.checkPinCollisions(input);
    const blocking = collisions.filter((c) => c.severity === 'BLOCK');
    if (blocking.length > 0 && !acknowledge) {
      throw new ConflictException({
        message: `Device pin collides with another student: ${blocking.map((b) => b.message).join(' ')}`,
        collisions,
        hint: 'Pass acknowledge_collisions: true to override deliberately.',
      });
    }
    return collisions;
  }

  private validatePersonRefs(personType: DevicePersonType, employeeId?: number | null, studentCc?: number | null) {
    if (personType === DevicePersonType.STAFF && !employeeId) {
      throw new BadRequestException('employee_id is required for STAFF mappings');
    }
    if (personType === DevicePersonType.STUDENT && !studentCc) {
      throw new BadRequestException('student_cc is required for STUDENT mappings');
    }
  }

  /**
   * Re-derives attribution for every scan on this PIN from the current mapping
   * state, then rebuilds the affected daily rows.
   *
   * Replaces the old reprocessOrphanScans, which only matched person_type=null
   * and so could *attach* history but never *correct* or *release* it. That is
   * why deactivating a mapping used to leave the person's attendance intact and
   * why re-pointing a PIN left every past scan welded to the previous owner.
   *
   * Runs inline so the change is visible on the very next read.
   *
   * @param overrideToUnmapped resolve as if no mapping exists — used by delete,
   *        where the row is already gone (or is about to be).
   */
  private async resolvePin(
    deviceSn: string,
    devicePin: string,
    actor: string,
    overrideToUnmapped = false,
  ): Promise<ResolutionReport | { skipped: true; scan_count: number; warning: string }> {
    const scanCount = await this.prisma.zk_attendance_scans.count({
      where: { device_sn: deviceSn, device_pin: devicePin },
    });

    if (scanCount > INLINE_RESOLVE_SCAN_LIMIT) {
      const warning =
        `${scanCount} scans on ${deviceSn}/${devicePin} exceed the inline limit (${INLINE_RESOLVE_SCAN_LIMIT}). ` +
        `The mapping was saved, but historical attendance was NOT rebuilt — run ` +
        `POST /attendance/zk-scan-resolution/resolve with {"kind":"device_pin","device_sn":"${deviceSn}",` +
        `"device_pin":"${devicePin}","dry_run":false} to finish.`;
      return { skipped: true, scan_count: scanCount, warning };
    }

    return this.resolution.resolve(
      { kind: 'device_pin', device_sn: deviceSn, device_pin: devicePin },
      { actor, dryRun: false, overrideToUnmapped },
    );
  }

  /**
   * Deletes a mapping and releases the scans it owned.
   *
   * Without the re-resolution, deleting a mapping left every historical scan
   * still attributed to that person — invisible to the unmapped-PIN screen, but
   * still driving their attendance, payroll and the parent portal.
   */
  async deleteMapping(id: number, actor: string) {
    const existing = await this.prisma.device_user_mappings.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Mapping not found');

    await this.prisma.device_user_mappings.delete({ where: { id } });

    await this.auditLogs.log({
      entity_type: 'ZK_ATTENDANCE_MAPPING',
      entity_id: String(id),
      action: 'DELETED',
      changed_by: actor,
      student_id: existing.student_cc ?? null,
      note:
        `Device mapping #${id} deleted (${existing.device_sn}/${existing.device_pin} → ` +
        `${existing.person_type === DevicePersonType.STAFF ? `employee #${existing.employee_id}` : `student #${existing.student_cc}`}). ` +
        `Its scans were released.`,
    });

    const resolution = await this.resolvePin(existing.device_sn, existing.device_pin, actor, true);
    return { mapping: existing, resolution };
  }
}
