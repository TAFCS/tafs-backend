import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { device_user_mappings, DevicePersonType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  DayAction,
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
import { CalendarDayResolverService } from '../hr/calendar/calendar-day-resolver.service';
import { AttendancePolicyResolverService } from './attendance-policy-resolver.service';

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
  /** Treat this (sn,pin) as having no mapping — previews a delete/deactivate. */
  overrideToUnmapped?: boolean;
  /**
   * Treat this (sn,pin) as if it mapped to this person — previews a LINK before
   * the mapping exists. Without it, previewing an unmapped pin reports no change,
   * because there is nothing to resolve to yet.
   */
  overrideToPerson?: PersonRef;
}

const DEFAULT_MAX_AFFECTED_DAYS = 5000;
const SCAN_PAGE_SIZE = 5000;
const UPDATE_CHUNK = 500;

@Injectable()
export class ZkScanResolutionService {
  private readonly logger = new Logger(ZkScanResolutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: ZkAttendanceProcessorService,
    private readonly auditLogs: AuditLogsService,
    private readonly calendarResolver: CalendarDayResolverService,
    private readonly policyResolver: AttendancePolicyResolverService,
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

    const release = dryRun ? null : this.acquireLock();
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
          : (opts.overrideToPerson ?? resolvePersonRef(mappingIndex.get(mappingKey(scan.device_sn, scan.device_pin))));

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

      // Every day in a run belongs to the same few people, so calendar and
      // policy resolution repeat constantly. Memo them for the run only.
      this.calendarResolver.beginBatch();
      this.policyResolver.beginBatch();
      this.processor.beginBatch();

      let outcomes: DayRecomputeOutcome[] = [];
      try {
        if (dryRun) {
          // Two bulk queries for the whole run instead of three per day — a
          // preview backs a confirm dialog, so it has to feel instant.
          outcomes = await this.projectAllDays([...affectedDays.entries()], scanDelta);
        } else {
          // Re-derive duplicates and sequence numbers for every affected day in
          // one bulk pass. Done per day this was several hundred round trips
          // against a remote DB and dominated the whole write path.
          const segments = await this.processor.prepareDaySegments([...affectedDays.values()]);

          for (const [key, d] of affectedDays.entries()) {
            try {
              outcomes.push(
                await this.processor.recomputePersonDay(d.personType, d.employeeId, d.studentCc, d.date, {
                  actor: opts.actor,
                  segment: segments.get(key),
                }),
              );
            } catch (err: any) {
              warnings.push(
                `Failed to recompute ${d.personType} ${d.employeeId ?? d.studentCc} on ` +
                  `${d.date.toISOString().slice(0, 10)}: ${err.message}`,
              );
            }
          }
        }
      } finally {
        this.calendarResolver.endBatch();
        this.policyResolver.endBatch();
        this.processor.endBatch();
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
      if (release) release();
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

  /**
   * Bulk equivalent of processor.projectPersonDay over many person-days: reads
   * every daily row and scan count in two queries, then derives each outcome in
   * memory from the pending scan delta.
   */
  private async projectAllDays(
    entries: [string, { personType: DevicePersonType; employeeId: number | null; studentCc: number | null; date: Date }][],
    scanDelta: Map<string, number>,
  ): Promise<DayRecomputeOutcome[]> {
    if (entries.length === 0) return [];

    const staffIds = [...new Set(entries.map((e) => e[1].employeeId).filter((v): v is number => v != null))];
    const studentIds = [...new Set(entries.map((e) => e[1].studentCc).filter((v): v is number => v != null))];
    const dates = [...new Set(entries.map((e) => e[1].date.toISOString()))].map((d) => new Date(d));

    const [staffDaily, studentDaily, staffCounts, studentCounts] = await Promise.all([
      staffIds.length
        ? this.prisma.attendance_staff_daily.findMany({
            where: { employee_id: { in: staffIds }, date: { in: dates } },
            select: { employee_id: true, date: true, status: true, source: true },
          })
        : Promise.resolve([] as any[]),
      studentIds.length
        ? this.prisma.attendance_student_daily.findMany({
            where: { student_cc: { in: studentIds }, date: { in: dates } },
            select: { student_cc: true, date: true, status: true, source: true },
          })
        : Promise.resolve([] as any[]),
      staffIds.length
        ? this.prisma.zk_attendance_scans.groupBy({
            by: ['employee_id', 'attendance_date'],
            where: {
              person_type: DevicePersonType.STAFF,
              employee_id: { in: staffIds },
              attendance_date: { in: dates },
              is_duplicate: false,
            },
            _count: { _all: true },
          })
        : Promise.resolve([] as any[]),
      studentIds.length
        ? this.prisma.zk_attendance_scans.groupBy({
            by: ['student_cc', 'attendance_date'],
            where: {
              person_type: DevicePersonType.STUDENT,
              student_cc: { in: studentIds },
              attendance_date: { in: dates },
              is_duplicate: false,
            },
            _count: { _all: true },
          })
        : Promise.resolve([] as any[]),
    ]);

    const dk = (d: Date) => d.toISOString().slice(0, 10);
    const dailyMap = new Map<string, { status: string; source: string }>();
    for (const r of staffDaily as any[]) dailyMap.set(`STAFF:${r.employee_id}:${dk(r.date)}`, { status: r.status, source: r.source });
    for (const r of studentDaily as any[]) dailyMap.set(`STUDENT:${r.student_cc}:${dk(r.date)}`, { status: r.status, source: r.source });

    const countMap = new Map<string, number>();
    for (const r of staffCounts as any[]) countMap.set(`STAFF:${r.employee_id}:${dk(r.attendance_date)}`, r._count._all);
    for (const r of studentCounts as any[]) countMap.set(`STUDENT:${r.student_cc}:${dk(r.attendance_date)}`, r._count._all);

    return entries.map(([key, d]) => {
      const id = d.personType === DevicePersonType.STAFF ? d.employeeId : d.studentCc;
      const mk = `${d.personType}:${id}:${dk(d.date)}`;
      const existing = dailyMap.get(mk);
      const before = countMap.get(mk) ?? 0;
      const after = Math.max(0, before + (scanDelta.get(key) ?? 0));

      const isProtected =
        d.personType === DevicePersonType.STAFF
          ? existing?.source === 'MANUAL' || existing?.source === 'SYSTEM' || existing?.source === 'LEAVE'
          : existing?.source === 'MANUAL' || existing?.source === 'SYSTEM';

      let action: DayAction;
      if (after === 0) {
        action = !existing ? 'NOOP' : existing.source !== 'BIOMETRIC' ? 'SKIPPED_PROTECTED_SOURCE' : 'CLEARED';
      } else {
        action = isProtected ? 'SKIPPED_PROTECTED_SOURCE' : 'UPSERTED';
      }

      return {
        personType: d.personType,
        employeeId: d.employeeId,
        studentCc: d.studentCc,
        date: d.date,
        scanCountBefore: before,
        scanCountAfter: after,
        statusBefore: existing?.status ?? null,
        statusAfter: action === 'CLEARED' ? null : (existing?.status ?? null),
        action,
      };
    });
  }

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

  /**
   * In-process guard against two concurrent runs.
   *
   * Deliberately NOT a Postgres advisory lock: those are session-scoped, and
   * Prisma hands each query a pooled connection (this deployment also fronts
   * Postgres with pgbouncer), so the unlock frequently lands on a different
   * connection than the lock and leaks it permanently.
   *
   * Per-instance rather than cluster-wide, which is enough here: the operation
   * is convergent (target state is a pure function of mappings x scans), so a
   * concurrent run on another instance would at worst duplicate work, and
   * excludeToday already keeps rebuilds away from live ingest.
   */
  private static running = false;

  private acquireLock(): () => void {
    if (ZkScanResolutionService.running) {
      throw new ConflictException('A scan re-resolution run is already in progress');
    }
    ZkScanResolutionService.running = true;
    return () => {
      ZkScanResolutionService.running = false;
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
    if (opts.overrideToUnmapped || opts.overrideToPerson || scans.length === 0) return index;

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
