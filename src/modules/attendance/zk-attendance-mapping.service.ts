import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

/** Returned instead of a ResolutionReport when a pin is too large to rebuild inline. */
export interface SkippedResolution {
  skipped: true;
  needs_rebuild: true;
  scan_count: number;
  warning: string;
  resolve_request: { kind: 'device_pin'; device_sn: string; device_pin: string; dry_run: false };
}

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

export type PinIdentityReason = 'PIN_EQUALS_CC' | 'PIN_EQUALS_GR' | 'PIN_EQUALS_EMPLOYEE_CODE';

export type PinLookupWarningCode =
  | 'NO_MAPPING'
  | 'MAPPING_INACTIVE'
  | 'PIN_MAPPED_TO_MULTIPLE_PEOPLE'
  | 'SCANS_CREDITED_TO_DIFFERENT_PERSON'
  | 'PIN_MATCHES_ANOTHER_PERSONS_IDENTITY'
  | 'DEVICE_NAME_HINT_DIFFERS';

export interface PinLookupWarning {
  code: PinLookupWarningCode;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
  device_sn?: string;
}

/** One person, however they were reached — mapping, scan attribution, or identity clash. */
export interface PinLookupPerson {
  kind: 'STAFF' | 'STUDENT';
  employee_id?: number;
  student_cc?: number;
  name: string;
  /** employee_code for staff, gr_number for students. */
  identifier: string | null;
  /** job title for staff, "Class — Section" for students. */
  detail: string | null;
  campus: string | null;
  status: string | null;
}

/** The employee columns every lookup query selects, whatever it selected them for. */
interface StaffPersonRow {
  id: number;
  full_name: string | null;
  employee_code: string | null;
  job_title: string | null;
  employment_status: string | null;
  campuses?: { campus_name: string | null } | null;
  departments?: { name: string } | null;
}

/** The student columns every lookup query selects. */
interface StudentPersonRow {
  cc: number;
  full_name: string;
  gr_number: string | null;
  status: string | null;
  classes?: { description: string } | null;
  sections?: { description: string } | null;
  campuses?: { campus_name: string | null } | null;
}

export type PinLookupMapping = device_user_mappings & {
  person: PinLookupPerson | null;
  scan_count: number;
  last_scan_at: Date | null;
  employee_profiles: { id: number; full_name: string | null; employee_code: string | null } | null;
  students: { cc: number; full_name: string; gr_number: string | null } | null;
};

/** Who the pin's stored scans are actually credited to — not necessarily the mapping. */
export interface PinScanAttribution {
  device_sn: string;
  scan_count: number;
  first_seen: Date | null;
  last_seen: Date | null;
  attributed_to: PinLookupPerson | null;
  matches_current_mapping: boolean;
}

export interface PinLookupResult {
  pin: string;
  /** Every stored spelling searched, e.g. "0123" also matches "123". */
  matched_pins: string[];
  device_sn: string | null;
  total_scans: number;
  mappings: PinLookupMapping[];
  scan_attributions: PinScanAttribution[];
  name_hints: { device_sn: string; device_pin: string; suggested_name: string | null; updated_at: Date }[];
  identity_matches: (PinLookupPerson & { reason: PinIdentityReason })[];
  history: {
    id: number;
    action: string;
    changed_by: string;
    changed_at: Date;
    note: string | null;
    entity_id: string;
  }[];
  warnings: PinLookupWarning[];
}

@Injectable()
export class ZkAttendanceMappingService {
  private readonly logger = new Logger(ZkAttendanceMappingService.name);

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

  async createMapping(dto: CreateDeviceMappingDto, userId: string, actor?: string) {
    const changedBy = actor ?? userId;
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
      changed_by: changedBy,
      student_id: mapping.student_cc ?? null,
      note: before
        ? `Device mapping #${mapping.id} upserted for ${mapping.device_sn}/${mapping.device_pin} → ${personRef}` +
          (mapping.display_name ? ` ("${mapping.display_name}")` : '') + '.'
        : `Device mapping #${mapping.id} created: ${mapping.device_sn}/${mapping.device_pin} → ${personRef}` +
          (mapping.display_name ? ` ("${mapping.display_name}")` : '') + '.',
    });

    const resolution = await this.resolvePin(mapping.device_sn, mapping.device_pin, changedBy);

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

  /**
   * Reverse lookup: "this pin exists on a device — whose is it?"
   *
   * Mis-mapped pins are only ever noticed from the pin side (a device shows a
   * scan, the wrong person's attendance moves), but every existing screen is
   * keyed by person, so answering that question meant a manual DB query. This
   * returns everything the system knows about one pin in a single shot:
   *
   *  - every mapping carrying that pin, on every device, active or not;
   *  - who its scans are ACTUALLY credited to, which can differ from the
   *    mapping when history has drifted (see scripts/audit-zk-scan-attribution.ts);
   *  - the name the device itself reports for the pin (zk_pin_name_hints);
   *  - people whose own identifiers (CC / GR / employee code) equal the pin —
   *    the root cause of the 6102 mis-credit, where a pin taken from a GR
   *    number was another student's CC.
   */
  async lookupPin(rawPin: string, deviceSn?: string): Promise<PinLookupResult> {
    const pin = (rawPin ?? '').trim();
    if (!pin) throw new BadRequestException('pin is required');

    // Operators type "0123" for a pin stored as "123" (and vice versa) — a
    // lookup that misses on leading zeros is worse than useless here.
    const variants = Array.from(
      new Set([pin, ...(/^\d+$/.test(pin) ? [String(Number(pin)), pin.replace(/^0+/, '')] : [])]),
    ).filter(Boolean);
    const pinAsNumber = /^\d+$/.test(pin) ? Number(pin) : null;
    const deviceFilter = deviceSn ? { device_sn: deviceSn } : {};

    const [rawMappings, scanGroups, hints] = await Promise.all([
      this.prisma.device_user_mappings.findMany({
        where: { device_pin: { in: variants }, ...deviceFilter },
        orderBy: [{ is_active: 'desc' }, { device_sn: 'asc' }],
        include: {
          employee_profiles: {
            select: {
              id: true,
              full_name: true,
              employee_code: true,
              job_title: true,
              employment_status: true,
              campuses: { select: { campus_name: true } },
              departments: { select: { name: true } },
            },
          },
          students: {
            select: {
              cc: true,
              full_name: true,
              gr_number: true,
              status: true,
              classes: { select: { description: true } },
              sections: { select: { description: true } },
              campuses: { select: { campus_name: true } },
            },
          },
        },
      }),
      this.prisma.zk_attendance_scans.groupBy({
        by: ['device_sn', 'person_type', 'employee_id', 'student_cc'],
        where: { device_pin: { in: variants }, ...deviceFilter },
        _count: { _all: true },
        _min: { scan_time: true },
        _max: { scan_time: true },
      }),
      this.prisma.zk_pin_name_hints.findMany({
        where: { device_pin: { in: variants }, ...deviceFilter },
        orderBy: { device_sn: 'asc' },
      }),
    ]);

    // Scans denormalize the person at ingest, so their employee/student refs are
    // resolved separately from the mapping's — that gap IS the drift we report.
    const scanEmployeeIds = scanGroups.map((g) => g.employee_id).filter((id): id is number => id != null);
    const scanStudentCcs = scanGroups.map((g) => g.student_cc).filter((cc): cc is number => cc != null);

    const [scanEmployees, scanStudents, identityStudents, identityEmployees] = await Promise.all([
      this.prisma.employee_profiles.findMany({
        where: { id: { in: scanEmployeeIds } },
        select: {
          id: true,
          full_name: true,
          employee_code: true,
          job_title: true,
          employment_status: true,
          campuses: { select: { campus_name: true } },
        },
      }),
      this.prisma.students.findMany({
        where: { cc: { in: scanStudentCcs } },
        select: {
          cc: true,
          full_name: true,
          gr_number: true,
          status: true,
          classes: { select: { description: true } },
          sections: { select: { description: true } },
          campuses: { select: { campus_name: true } },
        },
      }),
      this.prisma.students.findMany({
        where: {
          deleted_at: null,
          OR: [{ gr_number: { in: variants } }, ...(pinAsNumber !== null ? [{ cc: pinAsNumber }] : [])],
        },
        select: {
          cc: true,
          full_name: true,
          gr_number: true,
          status: true,
          classes: { select: { description: true } },
          sections: { select: { description: true } },
          campuses: { select: { campus_name: true } },
        },
      }),
      this.prisma.employee_profiles.findMany({
        where: { employee_code: { in: variants } },
        select: {
          id: true,
          full_name: true,
          employee_code: true,
          job_title: true,
          employment_status: true,
          campuses: { select: { campus_name: true } },
        },
      }),
    ]);

    const scanEmployeeMap = new Map(scanEmployees.map((e) => [e.id, e] as const));
    const scanStudentMap = new Map(scanStudents.map((s) => [s.cc, s] as const));

    const mappings = rawMappings.map((m) => {
      const person = m.employee_profiles
        ? this.toStaffPerson(m.employee_profiles)
        : m.students
          ? this.toStudentPerson(m.students)
          : null;
      const own = scanGroups.filter(
        (g) =>
          g.device_sn === m.device_sn &&
          ((m.employee_id != null && g.employee_id === m.employee_id) ||
            (m.student_cc != null && g.student_cc === m.student_cc)),
      );
      return {
        ...m,
        person,
        scan_count: own.reduce((sum, g) => sum + g._count._all, 0),
        last_scan_at: own.reduce<Date | null>(
          (latest, g) => (g._max.scan_time && (!latest || g._max.scan_time > latest) ? g._max.scan_time : latest),
          null,
        ),
      };
    });

    const activeByDevice = new Map(mappings.filter((m) => m.is_active).map((m) => [m.device_sn, m]));

    const attributions: PinScanAttribution[] = scanGroups
      .map((g) => {
        const person =
          g.employee_id != null && scanEmployeeMap.has(g.employee_id)
            ? this.toStaffPerson(scanEmployeeMap.get(g.employee_id)!)
            : g.student_cc != null && scanStudentMap.has(g.student_cc)
              ? this.toStudentPerson(scanStudentMap.get(g.student_cc)!)
              : null;
        const active = activeByDevice.get(g.device_sn);
        const matchesMapping = active
          ? (active.employee_id ?? null) === (g.employee_id ?? null) &&
            (active.student_cc ?? null) === (g.student_cc ?? null)
          : g.employee_id == null && g.student_cc == null;
        return {
          device_sn: g.device_sn,
          scan_count: g._count._all,
          first_seen: g._min.scan_time,
          last_seen: g._max.scan_time,
          attributed_to: person,
          matches_current_mapping: matchesMapping,
        };
      })
      .sort((a, b) => (b.last_seen?.getTime() ?? 0) - (a.last_seen?.getTime() ?? 0));

    const totalScans = attributions.reduce((sum, a) => sum + a.scan_count, 0);

    const mappingIds = mappings.map((m) => String(m.id));
    const history = await this.prisma.audit_logs.findMany({
      where: {
        entity_type: 'ZK_ATTENDANCE_MAPPING',
        OR: [
          ...(mappingIds.length ? [{ entity_id: { in: mappingIds } }] : []),
          ...variants.map((v) => ({ entity_id: { endsWith: `/${v}` } })),
          ...variants.map((v) => ({ note: { contains: `/${v} ` } })),
        ],
      },
      orderBy: { changed_at: 'desc' },
      take: 25,
      select: { id: true, action: true, changed_by: true, changed_at: true, note: true, entity_id: true },
    });

    return {
      pin,
      matched_pins: variants,
      device_sn: deviceSn ?? null,
      total_scans: totalScans,
      mappings,
      scan_attributions: attributions,
      name_hints: hints.map((h) => ({
        device_sn: h.device_sn,
        device_pin: h.device_pin,
        suggested_name: h.suggested_name,
        updated_at: h.updated_at,
      })),
      identity_matches: [
        ...identityStudents.map((s) => ({
          ...this.toStudentPerson(s),
          reason: (s.cc === pinAsNumber ? 'PIN_EQUALS_CC' : 'PIN_EQUALS_GR') as PinIdentityReason,
        })),
        ...identityEmployees.map((e) => ({
          ...this.toStaffPerson(e),
          reason: 'PIN_EQUALS_EMPLOYEE_CODE' as PinIdentityReason,
        })),
      ],
      history,
      warnings: this.buildPinLookupWarnings(pin, mappings, attributions, hints, identityStudents, pinAsNumber),
    };
  }

  /** Flattens an employee row into the one shape every lookup panel renders. */
  private toStaffPerson(row: StaffPersonRow): PinLookupPerson {
    return {
      kind: 'STAFF',
      employee_id: row.id,
      name: row.full_name ?? 'Unnamed employee',
      identifier: row.employee_code ?? null,
      detail: row.job_title ?? row.departments?.name ?? null,
      campus: row.campuses?.campus_name ?? null,
      status: row.employment_status ?? null,
    };
  }

  /** Student counterpart of toStaffPerson. */
  private toStudentPerson(row: StudentPersonRow): PinLookupPerson {
    const classLabel = [row.classes?.description, row.sections?.description]
      .filter(Boolean)
      .join(' — ');
    return {
      kind: 'STUDENT',
      student_cc: row.cc,
      name: row.full_name,
      identifier: row.gr_number ?? null,
      detail: classLabel || null,
      campus: row.campuses?.campus_name ?? null,
      status: row.status ?? null,
    };
  }

  private buildPinLookupWarnings(
    pin: string,
    mappings: Array<{
      device_sn: string;
      is_active: boolean;
      employee_id: number | null;
      student_cc: number | null;
      person: PinLookupPerson | null;
    }>,
    attributions: PinScanAttribution[],
    hints: Array<{ device_sn: string; suggested_name: string | null }>,
    identityStudents: Array<{ cc: number; full_name: string; gr_number: string | null }>,
    pinAsNumber: number | null,
  ): PinLookupWarning[] {
    const warnings: PinLookupWarning[] = [];
    const active = mappings.filter((m) => m.is_active);

    if (mappings.length === 0) {
      warnings.push({
        code: 'NO_MAPPING',
        severity: attributions.length > 0 ? 'HIGH' : 'LOW',
        message:
          attributions.length > 0
            ? `Pin ${pin} has scans but no mapping — those scans belong to nobody and count towards no one's attendance.`
            : `Pin ${pin} is not mapped and has never scanned.`,
      });
    } else if (active.length === 0) {
      warnings.push({
        code: 'MAPPING_INACTIVE',
        severity: 'MEDIUM',
        message: `Every mapping for pin ${pin} is inactive, so new scans on it are ignored.`,
      });
    }

    const distinctPeople = new Set(
      active.map((m) => (m.employee_id != null ? `STAFF:${m.employee_id}` : `STUDENT:${m.student_cc}`)),
    );
    if (distinctPeople.size > 1) {
      warnings.push({
        code: 'PIN_MAPPED_TO_MULTIPLE_PEOPLE',
        severity: 'HIGH',
        message:
          `Pin ${pin} is actively mapped to ${distinctPeople.size} different people across devices: ` +
          active.map((m) => `${m.person?.name ?? 'Unknown'} on ${m.device_sn}`).join(', ') + '.',
      });
    }

    for (const a of attributions.filter((x) => !x.matches_current_mapping)) {
      const owner = active.find((m) => m.device_sn === a.device_sn);
      const creditedTo = a.attributed_to
        ? `${a.attributed_to.name}${a.attributed_to.identifier ? ` (${a.attributed_to.identifier})` : ''}`
        : 'nobody';
      warnings.push({
        code: 'SCANS_CREDITED_TO_DIFFERENT_PERSON',
        severity: 'HIGH',
        device_sn: a.device_sn,
        message:
          `${a.scan_count} scan(s) on ${a.device_sn} are credited to ${creditedTo}, but ` +
          (owner?.person
            ? `the pin now maps to ${owner.person.name} there. Rebuild the pin to re-attribute them.`
            : `the pin has no active mapping on that device. Rebuild the pin to release them.`),
      });
    }

    for (const s of identityStudents) {
      const isMappedToThem = mappings.some((m) => m.student_cc === s.cc);
      if (isMappedToThem) continue;
      warnings.push({
        code: 'PIN_MATCHES_ANOTHER_PERSONS_IDENTITY',
        severity: 'HIGH',
        message:
          `Pin ${pin} is ${s.cc === pinAsNumber ? 'the CC' : `the GR number (${s.gr_number})`} of ${s.full_name} ` +
          `(cc ${s.cc}), who is NOT who this pin is mapped to. This is how scans get credited to the wrong student.`,
      });
    }

    // Devices carry the enrolled name themselves, so a hint that shares no word
    // with the mapped person is the cheapest signal that the pin was mapped to
    // the wrong human in the first place.
    for (const h of hints) {
      const mapped = mappings.find((m) => m.device_sn === h.device_sn)?.person?.name;
      if (!h.suggested_name || !mapped) continue;
      const tokens = (s: string) =>
        new Set(
          s
            .toUpperCase()
            .replace(/[^A-Z\s]/g, ' ')
            .split(/\s+/)
            .filter((t) => t.length > 2 && !['MR', 'MRS', 'MS', 'SIR', 'MISS'].includes(t)),
        );
      const hintTokens = tokens(h.suggested_name);
      const mappedTokens = tokens(mapped);
      if (hintTokens.size === 0 || mappedTokens.size === 0) continue;
      if ([...hintTokens].some((t) => mappedTokens.has(t))) continue;
      warnings.push({
        code: 'DEVICE_NAME_HINT_DIFFERS',
        severity: 'MEDIUM',
        device_sn: h.device_sn,
        message:
          `Device ${h.device_sn} reports pin ${pin} as "${h.suggested_name}", but it is mapped to ${mapped}. ` +
          `Confirm which one is right before trusting this pin's attendance.`,
      });
    }

    return warnings;
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
  ): Promise<ResolutionReport | SkippedResolution> {
    const scanCount = await this.prisma.zk_attendance_scans.count({
      where: { device_sn: deviceSn, device_pin: devicePin },
    });

    if (scanCount > INLINE_RESOLVE_SCAN_LIMIT) {
      // Loud on purpose. A silently-skipped rebuild leaves the mapping changed
      // but history stale — the exact drift this whole feature exists to remove,
      // except invisible. Callers must see and handle this state explicitly.
      const warning =
        `${scanCount} scans on ${deviceSn}/${devicePin} exceed the inline limit (${INLINE_RESOLVE_SCAN_LIMIT}). ` +
        `The mapping was saved, but historical attendance was NOT rebuilt — run ` +
        `POST /attendance/zk-scan-resolution/resolve with {"kind":"device_pin","device_sn":"${deviceSn}",` +
        `"device_pin":"${devicePin}","dry_run":false} to finish.`;

      this.logger.warn(warning);
      await this.auditLogs.log({
        entity_type: 'ZK_ATTENDANCE_MAPPING',
        entity_id: `${deviceSn}/${devicePin}`,
        action: 'UPDATED',
        section: 'attendance',
        changed_by: actor,
        note: `PENDING REBUILD — ${warning}`,
      });

      return {
        skipped: true,
        needs_rebuild: true,
        scan_count: scanCount,
        warning,
        resolve_request: {
          kind: 'device_pin',
          device_sn: deviceSn,
          device_pin: devicePin,
          dry_run: false,
        },
      };
    }

    return this.resolution.resolve(
      { kind: 'device_pin', device_sn: deviceSn, device_pin: devicePin },
      // excludeToday guards scheduled bulk rebuilds from racing live device
      // pushes. This is a single-pin resolve triggered by the operator's own
      // mapping edit, not a bulk job — leaving today excluded here left the
      // pin's today-dated scans stuck at person_type null, so it lingered on
      // the unmapped-PIN screen after being mapped.
      { actor, dryRun: false, overrideToUnmapped, excludeToday: false },
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
