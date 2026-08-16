import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { device_user_mappings, DevicePersonType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  DayRecomputeOutcome,
  MANUAL_DEVICE_SN,
  ZkAttendanceProcessorService,
} from './zk-attendance-processor.service';
import {
  describePersonRef,
  isAttributed,
  mappingKey,
  PersonRef,
  personDayKey,
  resolvePersonRef,
  samePersonRef,
  UNATTRIBUTED,
} from './device-mapping-resolution.util';

export type ResolutionScope =
  | { kind: 'scan_ids'; scan_ids: number[] }
  | { kind: 'device_pin'; device_sn: string; device_pin: string; date_from?: Date; date_to?: Date }
  | { kind: 'device'; device_sn: string; date_from?: Date; date_to?: Date }
  | { kind: 'date_range'; date_from: Date; date_to: Date; device_sn?: string };

export type ReattributionKind = 'ATTACH' | 'REPOINT' | 'ORPHAN';

export interface ScanReattribution {
  scan_id: number;
  device_sn: string;
  device_pin: string;
  attendance_date: string;
  from: PersonRef;
  to: PersonRef;
  kind: ReattributionKind;
}

export interface ResolutionReport {
  dry_run: boolean;
  scans_examined: number;
  unchanged: number;
  attached: number;
  repointed: number;
  orphaned: number;
  reattributions: ScanReattribution[];
  affected_days: DayRecomputeOutcome[];
  daily_summary: Record<string, number>;
  warnings: string[];
  duration_ms: number;
}

export interface ResolveOptions {
  actor: string;
  dryRun?: boolean;
  /** Skip today so a rebuild never races live device pushes. */
  excludeToday?: boolean;
  /** Refuse to run when the blast radius exceeds this many person-days. */
  maxAffectedDays?: number;
  force?: boolean;
  /** Treat this (sn,pin) as having no mapping — used to preview a delete. */
  overrideToUnmapped?: boolean;
}

const DEFAULT_MAX_AFFECTED_DAYS = 5000;
const SCAN_PAGE_SIZE = 5000;
const UPDATE_CHUNK = 500;
const ADVISORY_LOCK_KEY = 'zk-scan-resolution';

@Injectable()
export class ZkScanResolutionService {
  private readonly logger = new Logger(ZkScanResolutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: ZkAttendanceProcessorService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * Re-derives each scan's attributed person from the CURRENT device_user_mappings
   * state, then rebuilds the daily attendance rows for every person-day touched
   * — on BOTH sides of a change, so the previous owner loses the day they no
   * longer have scans for.
   */
  async resolve(scope: ResolutionScope, opts: ResolveOptions): Promise<ResolutionReport> {
    const started = Date.now();
    const dryRun = opts.dryRun !== false;
    const maxAffectedDays = opts.maxAffectedDays ?? DEFAULT_MAX_AFFECTED_DAYS;
    const warnings: string[] = [];

    const release = dryRun ? null : await this.acquireLock();
    try {
      const scans = await this.loadScans(scope, opts, warnings);
      const mappingIndex = await this.loadMappingIndex(scans, opts);

      const reattributions: ScanReattribution[] = [];
      const affectedDays = new Map<
        string,
        { personType: DevicePersonType; employeeId: number | null; studentCc: number | null; date: Date }
      >();
      // Net change in non-duplicate scans per person-day, so a dry run can
      // predict the POST-move outcome rather than describing the current state.
      const scanDelta = new Map<string, number>();

      const addDay = (ref: PersonRef, date: Date, delta: number) => {
        const key = personDayKey(ref, date);
        if (!key) return;
        if (!affectedDays.has(key)) {
          affectedDays.set(key, {
            personType: ref.person_type!,
            employeeId: ref.employee_id,
            studentCc: ref.student_cc,
            date,
          });
        }
        scanDelta.set(key, (scanDelta.get(key) ?? 0) + delta);
      };

      for (const scan of scans) {
        const current: PersonRef = {
          person_type: scan.person_type,
          employee_id: scan.employee_id,
          student_cc: scan.student_cc,
        };
        const desired = opts.overrideToUnmapped
          ? { ...UNATTRIBUTED }
          : resolvePersonRef(mappingIndex.get(mappingKey(scan.device_sn, scan.device_pin)));

        if (samePersonRef(current, desired)) continue;

        reattributions.push({
          scan_id: scan.id,
          device_sn: scan.device_sn,
          device_pin: scan.device_pin,
          attendance_date: scan.attendance_date.toISOString().slice(0, 10),
          from: current,
          to: desired,
          kind: !isAttributed(current) ? 'ATTACH' : !isAttributed(desired) ? 'ORPHAN' : 'REPOINT',
        });

        // Both sides: the old owner must lose the day, the new owner must gain it.
        // Duplicates don't count toward a day's scan total, so they don't move the delta.
        const weight = scan.is_duplicate ? 0 : 1;
        addDay(current, scan.attendance_date, -weight);
        addDay(desired, scan.attendance_date, weight);
      }

      if (affectedDays.size > maxAffectedDays && !opts.force) {
        throw new BadRequestException(
          `Re-resolution would rebuild ${affectedDays.size} person-days (limit ${maxAffectedDays}). ` +
            `Narrow the scope with a date range, or pass force to override.`,
        );
      }

      const counts = {
        attached: reattributions.filter((r) => r.kind === 'ATTACH').length,
        repointed: reattributions.filter((r) => r.kind === 'REPOINT').length,
        orphaned: reattributions.filter((r) => r.kind === 'ORPHAN').length,
      };

      // Rewrite ALL attributions before touching any daily row. Interleaving
      // would compute a day from a half-migrated scan set.
      if (!dryRun && reattributions.length > 0) {
        await this.applyReattributions(reattributions);
      }

      const outcomes: DayRecomputeOutcome[] = [];
      for (const [key, d] of affectedDays.entries()) {
        try {
          let outcome: DayRecomputeOutcome;
          if (dryRun) {
            const current = await this.countNonDuplicateScans(d.personType, d.employeeId, d.studentCc, d.date);
            const projected = Math.max(0, current + (scanDelta.get(key) ?? 0));
            outcome = await this.processor.projectPersonDay(
              d.personType,
              d.employeeId,
              d.studentCc,
              d.date,
              projected,
            );
          } else {
            outcome = await this.processor.recomputePersonDay(d.personType, d.employeeId, d.studentCc, d.date, {
              actor: opts.actor,
            });
          }
          outcomes.push(outcome);
        } catch (err: any) {
          warnings.push(
            `Failed to recompute ${d.personType} ${d.employeeId ?? d.studentCc} on ` +
              `${d.date.toISOString().slice(0, 10)}: ${err.message}`,
          );
        }
      }

      const dailySummary = outcomes.reduce<Record<string, number>>((acc, o) => {
        acc[o.action] = (acc[o.action] ?? 0) + 1;
        return acc;
      }, {});

      if (!dryRun && reattributions.length > 0) {
        await this.writeAuditLog(scope, opts.actor, counts, affectedDays.size, dailySummary);
      }

      return {
        dry_run: dryRun,
        scans_examined: scans.length,
        unchanged: scans.length - reattributions.length,
        ...counts,
        reattributions,
        affected_days: outcomes,
        daily_summary: dailySummary,
        warnings,
        duration_ms: Date.now() - started,
      };
    } finally {
      if (release) await release();
    }
  }

  /** Convenience wrapper for the mapping lifecycle hooks. */
  async resolveForDevicePin(
    deviceSn: string,
    devicePin: string,
    opts: ResolveOptions,
  ): Promise<ResolutionReport> {
    return this.resolve({ kind: 'device_pin', device_sn: deviceSn, device_pin: devicePin }, opts);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async countNonDuplicateScans(
    personType: DevicePersonType,
    employeeId: number | null,
    studentCc: number | null,
    date: Date,
  ): Promise<number> {
    return this.prisma.zk_attendance_scans.count({
      where: {
        person_type: personType,
        ...(personType === DevicePersonType.STAFF ? { employee_id: employeeId } : { student_cc: studentCc }),
        attendance_date: date,
        is_duplicate: false,
      },
    });
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const [{ ok }] = await this.prisma.$queryRaw<{ ok: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext(${ADVISORY_LOCK_KEY})) AS ok`;
    if (!ok) {
      throw new ConflictException('A scan re-resolution run is already in progress');
    }
    return async () => {
      await this.prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext(${ADVISORY_LOCK_KEY}))`;
    };
  }

  private async loadScans(scope: ResolutionScope, opts: ResolveOptions, warnings: string[]) {
    const where: any = { device_sn: { not: MANUAL_DEVICE_SN } };

    if (scope.kind === 'scan_ids') {
      if (scope.scan_ids.length === 0) throw new BadRequestException('scan_ids must not be empty');
      where.id = { in: scope.scan_ids };
    } else if (scope.kind === 'device_pin') {
      where.device_sn = scope.device_sn;
      where.device_pin = scope.device_pin;
      this.applyDateFilter(where, scope.date_from, scope.date_to);
    } else if (scope.kind === 'device') {
      where.device_sn = scope.device_sn;
      this.applyDateFilter(where, scope.date_from, scope.date_to);
    } else {
      if (scope.device_sn) where.device_sn = scope.device_sn;
      this.applyDateFilter(where, scope.date_from, scope.date_to);
    }

    if (opts.excludeToday !== false) {
      const todayUtc = new Date();
      todayUtc.setUTCHours(0, 0, 0, 0);
      const existing = where.attendance_date ?? {};
      const cap = new Date(todayUtc.getTime() - 24 * 60 * 60 * 1000);
      where.attendance_date = { ...existing, lte: existing.lte && existing.lte < cap ? existing.lte : cap };
    }

    const out: {
      id: number;
      device_sn: string;
      device_pin: string;
      person_type: DevicePersonType | null;
      employee_id: number | null;
      student_cc: number | null;
      attendance_date: Date;
      is_duplicate: boolean;
    }[] = [];

    let cursor: number | undefined;
    for (;;) {
      const page = await this.prisma.zk_attendance_scans.findMany({
        where,
        select: {
          id: true,
          device_sn: true,
          device_pin: true,
          person_type: true,
          employee_id: true,
          student_cc: true,
          attendance_date: true,
          is_duplicate: true,
        },
        orderBy: { id: 'asc' },
        take: SCAN_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      out.push(...page);
      if (page.length < SCAN_PAGE_SIZE) break;
      cursor = page[page.length - 1].id;
    }

    if (scope.kind === 'scan_ids') {
      const found = new Set(out.map((s) => s.id));
      const missing = scope.scan_ids.filter((id) => !found.has(id));
      if (missing.length > 0) {
        warnings.push(`${missing.length} scan id(s) not found or excluded by filters: ${missing.join(', ')}`);
      }
    }
    return out;
  }

  private applyDateFilter(where: any, from?: Date, to?: Date) {
    if (!from && !to) return;
    where.attendance_date = {};
    if (from) where.attendance_date.gte = from;
    if (to) where.attendance_date.lte = to;
  }

  private async loadMappingIndex(
    scans: { device_sn: string; device_pin: string }[],
    opts: ResolveOptions,
  ): Promise<Map<string, device_user_mappings>> {
    const index = new Map<string, device_user_mappings>();
    if (opts.overrideToUnmapped || scans.length === 0) return index;

    const deviceSns = [...new Set(scans.map((s) => s.device_sn))];
    const mappings = await this.prisma.device_user_mappings.findMany({
      where: { device_sn: { in: deviceSns } },
    });
    for (const m of mappings) index.set(mappingKey(m.device_sn, m.device_pin), m);
    return index;
  }

  /** Grouped by identical target so each updateMany writes one concrete tuple. */
  private async applyReattributions(reattributions: ScanReattribution[]) {
    const groups = new Map<string, { to: PersonRef; ids: number[] }>();
    for (const r of reattributions) {
      const key = `${r.to.person_type ?? ''}|${r.to.employee_id ?? ''}|${r.to.student_cc ?? ''}`;
      const g = groups.get(key);
      if (g) g.ids.push(r.scan_id);
      else groups.set(key, { to: r.to, ids: [r.scan_id] });
    }

    for (const { to, ids } of groups.values()) {
      for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
        const chunk = ids.slice(i, i + UPDATE_CHUNK);
        await this.prisma.zk_attendance_scans.updateMany({
          where: { id: { in: chunk } },
          // All three written explicitly — `undefined` would leave the opposite
          // person column stale, which is the bug this whole change exists to fix.
          data: {
            person_type: to.person_type,
            employee_id: to.employee_id,
            student_cc: to.student_cc,
          },
        });
      }
    }
  }

  private async writeAuditLog(
    scope: ResolutionScope,
    actor: string,
    counts: { attached: number; repointed: number; orphaned: number },
    affectedDays: number,
    dailySummary: Record<string, number>,
  ) {
    const scopeDesc =
      scope.kind === 'scan_ids'
        ? `${scope.scan_ids.length} scan id(s)`
        : scope.kind === 'device_pin'
          ? `${scope.device_sn}/${scope.device_pin}`
          : scope.kind === 'device'
            ? scope.device_sn
            : `${scope.date_from.toISOString().slice(0, 10)}..${scope.date_to.toISOString().slice(0, 10)}`;

    await this.auditLogs.log({
      entity_type: 'ZK_SCAN_RESOLUTION',
      entity_id: scopeDesc,
      action: 'UPDATED',
      section: 'attendance',
      changed_by: actor,
      note:
        `Re-resolved scan attribution for ${scopeDesc}: ` +
        `${counts.attached} attached, ${counts.repointed} repointed, ${counts.orphaned} orphaned; ` +
        `${affectedDays} person-day(s) rebuilt (${JSON.stringify(dailySummary)}).`,
    });
  }

  /** Human-readable one-liner per reattribution, for CLI/API consumers. */
  static describe(r: ScanReattribution): string {
    return `scan #${r.scan_id} ${r.attendance_date} ${r.device_sn}/${r.device_pin}: ${describePersonRef(r.from)} → ${describePersonRef(r.to)}`;
  }
}
