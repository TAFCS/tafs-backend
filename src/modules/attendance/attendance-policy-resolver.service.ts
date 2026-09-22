import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  EmployeeExpectedTimesService,
  ExpectedTimesResult,
} from '../timetables/employee-expected-times.service';

/**
 * What a student's campus+class pairing says about their day.
 *
 * `endTime` and `intermediateTime` only ever come from a class_check_in_schedules
 * row — hr_policy_sets has no notion of either, so a campus-default fallback
 * yields nulls for both and the punch resolver keeps legacy parity.
 */
export type StudentCheckInPolicy = {
  expectedCheckIn: Date | null;
  endTime: Date | null;
  intermediateTime: Date | null;
  graceMinutes: number;
};

const NO_STUDENT_POLICY: StudentCheckInPolicy = {
  expectedCheckIn: null,
  endTime: null,
  intermediateTime: null,
  graceMinutes: 0,
};

type PolicyRuleRow = {
  rule_type: string;
  value_json: unknown;
  applies_to: string | null;
};

@Injectable()
export class AttendancePolicyResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expectedTimes: EmployeeExpectedTimesService,
  ) {}

  /** See CalendarDayResolverService.beginBatch — same contract. */
  private batchCache: Map<string, unknown> | null = null;

  beginBatch(): void {
    this.batchCache = new Map();
  }

  endBatch(): void {
    this.batchCache = null;
  }

  private async memoPolicy<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.batchCache) return load();
    const hit = this.batchCache.get(key);
    if (hit !== undefined) return hit as T;
    const val = await load();
    this.batchCache.set(key, val);
    return val;
  }

  async resolveActivePolicySet(campusId: number, date: Date) {
    return this.prisma.hr_policy_sets.findFirst({
      where: {
        campus_id: campusId,
        effective_from: { lte: date },
      },
      orderBy: { effective_from: 'desc' },
      include: {
        hr_policy_rules: true,
      },
    });
  }

  /** All policy sets active on [date], newest effective_from first. */
  async listActivePolicySets(campusId: number, date: Date) {
    return this.prisma.hr_policy_sets.findMany({
      where: {
        campus_id: campusId,
        effective_from: { lte: date },
      },
      orderBy: { effective_from: 'desc' },
      include: { hr_policy_rules: true },
    });
  }

  private parseTimeRule(rules: PolicyRuleRow[], ...ruleTypes: string[]): Date | null {
    const rule = rules.find((r) => ruleTypes.includes(r.rule_type));
    if (!rule?.value_json || typeof rule.value_json !== 'object') return null;

    const val = rule.value_json as { time?: string };
    if (!val.time) return null;

    const parts = val.time.split(':').map((p) => parseInt(p, 10));
    const h = parts[0];
    const m = parts[1] ?? 0;
    if (Number.isNaN(h) || Number.isNaN(m)) return null;

    return new Date(Date.UTC(1970, 0, 1, h, m, 0));
  }

  private parseGraceRule(rules: PolicyRuleRow[], ...ruleTypes: string[]): number {
    const rule = rules.find((r) => ruleTypes.includes(r.rule_type));
    if (!rule?.value_json || typeof rule.value_json !== 'object') return 0;

    const val = rule.value_json as { minutes?: number | string };
    const raw = val.minutes;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      const n = parseInt(raw, 10);
      return Number.isNaN(n) ? 0 : n;
    }
    return 0;
  }

  /**
   * Walk policy sets newest-first and pick the first set that defines a check-in
   * time. Fixes the case where the newest set has other rules but no time rule
   * (rules were saved on an older academic-year set in the UI).
   */
  private resolveStudentRulesFromPolicySets(
    sets: Array<{ hr_policy_rules: PolicyRuleRow[] }>,
  ): StudentCheckInPolicy {
    for (const set of sets) {
      const rules = set.hr_policy_rules;
      const expectedCheckIn = this.parseTimeRule(
        rules,
        'EXPECTED_CHECK_IN_TIME_STUDENT',
        'EXPECTED_CHECK_IN_TIME',
      );
      if (expectedCheckIn) {
        const graceMinutes = this.parseGraceRule(
          rules,
          'LATE_GRACE_PERIOD_MINS_STUDENT',
          'LATE_GRACE_PERIOD_MINS',
        );
        return { expectedCheckIn, endTime: null, intermediateTime: null, graceMinutes };
      }
    }
    return NO_STUDENT_POLICY;
  }

  private resolveStaffRulesFromPolicySets(
    sets: Array<{ hr_policy_rules: PolicyRuleRow[] }>,
  ): { expectedCheckIn: Date | null; graceMinutes: number } {
    for (const set of sets) {
      const rules = set.hr_policy_rules;
      const expectedCheckIn = this.parseTimeRule(
        rules,
        'EXPECTED_CHECK_IN_TIME_STAFF',
        'EXPECTED_CHECK_IN_TIME',
      );
      if (expectedCheckIn) {
        const graceMinutes = this.parseGraceRule(
          rules,
          'LATE_GRACE_PERIOD_MINS_STAFF',
          'LATE_GRACE_PERIOD_MINS',
        );
        return { expectedCheckIn, graceMinutes };
      }
    }
    return { expectedCheckIn: null, graceMinutes: 0 };
  }

  /**
   * Pick the pairing's schedule out of an already-loaded list.
   *
   * `campusId` is required. It used to be absent here while the uncached path
   * filtered on it, so the two could resolve different schedules for the same
   * student — and since classes are shared across campuses via campus_classes,
   * a cached lookup would happily hand back another campus's timings.
   *
   * Schedules are dated, so take the newest one that has come into effect, not
   * merely the first match in the array.
   */
  resolveStudentCheckInPolicyFromCache(
    classId: number | null,
    campusId: number | null,
    date: Date,
    schedules: Array<{
      class_id: number;
      campus_id: number;
      expected_check_in: Date;
      end_time?: Date | null;
      intermediate_time?: Date | null;
      late_grace_minutes: number;
      effective_from: Date;
    }>,
    policySets: Array<{ effective_from: Date; hr_policy_rules: PolicyRuleRow[] }>,
  ): StudentCheckInPolicy {
    if (classId != null && campusId != null) {
      const schedule = schedules
        .filter((s) => s.class_id === classId && s.campus_id === campusId && s.effective_from <= date)
        .sort((a, b) => b.effective_from.getTime() - a.effective_from.getTime())[0];
      if (schedule) {
        return {
          expectedCheckIn: schedule.expected_check_in,
          endTime: schedule.end_time ?? null,
          intermediateTime: schedule.intermediate_time ?? null,
          graceMinutes: schedule.late_grace_minutes,
        };
      }
    }

    const activePolicySets = policySets.filter((p) => p.effective_from <= date);
    if (activePolicySets.length > 0) {
      return this.resolveStudentRulesFromPolicySets(activePolicySets);
    }

    return NO_STUDENT_POLICY;
  }

  async resolveStudentCheckInPolicy(
    classId: number | null,
    campusId: number,
    date: Date,
  ): Promise<StudentCheckInPolicy> {
    return this.memoPolicy(`stu:${classId ?? '-'}:${campusId}:${date.toISOString().slice(0, 10)}`, () =>
      this.resolveStudentCheckInPolicyUncached(classId, campusId, date),
    );
  }

  private async resolveStudentCheckInPolicyUncached(
    classId: number | null,
    campusId: number,
    date: Date,
  ): Promise<StudentCheckInPolicy> {
    if (classId != null) {
      const schedule = await this.prisma.class_check_in_schedules.findFirst({
        where: {
          class_id: classId,
          campus_id: campusId,
          effective_from: { lte: date },
        },
        orderBy: { effective_from: 'desc' },
      });

      if (schedule) {
        return {
          expectedCheckIn: schedule.expected_check_in,
          endTime: schedule.end_time,
          intermediateTime: schedule.intermediate_time,
          graceMinutes: schedule.late_grace_minutes,
        };
      }
    }

    const policySets = await this.listActivePolicySets(campusId, date);
    if (policySets.length > 0) {
      return this.resolveStudentRulesFromPolicySets(policySets);
    }

    return NO_STUDENT_POLICY;
  }

  async resolveStaffCheckInPolicy(
    employeeId: number,
    campusId: number,
    date: Date,
  ): Promise<ExpectedTimesResult> {
    return this.memoPolicy(`stf:${employeeId}:${campusId}:${date.toISOString().slice(0, 10)}`, () =>
      this.expectedTimes.resolveExpectedTimes(employeeId, campusId, date),
    );
  }
}
