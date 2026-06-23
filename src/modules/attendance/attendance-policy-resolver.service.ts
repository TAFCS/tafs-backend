import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

type PolicyRuleRow = {
  rule_type: string;
  value_json: unknown;
  applies_to: string | null;
};

@Injectable()
export class AttendancePolicyResolverService {
  constructor(private readonly prisma: PrismaService) {}

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
  ): { expectedCheckIn: Date | null; graceMinutes: number } {
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
        return { expectedCheckIn, graceMinutes };
      }
    }
    return { expectedCheckIn: null, graceMinutes: 0 };
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

  resolveStudentCheckInPolicyFromCache(
    classId: number | null,
    date: Date,
    schedules: Array<{ class_id: number; expected_check_in: Date; late_grace_minutes: number; effective_from: Date }>,
    policySets: Array<{ effective_from: Date; hr_policy_rules: PolicyRuleRow[] }>,
  ): { expectedCheckIn: Date | null; graceMinutes: number } {
    if (classId != null) {
      const schedule = schedules.find((s) => s.class_id === classId && s.effective_from <= date);
      if (schedule) {
        return {
          expectedCheckIn: schedule.expected_check_in,
          graceMinutes: schedule.late_grace_minutes,
        };
      }
    }

    const activePolicySets = policySets.filter((p) => p.effective_from <= date);
    if (activePolicySets.length > 0) {
      return this.resolveStudentRulesFromPolicySets(activePolicySets);
    }

    return { expectedCheckIn: null, graceMinutes: 0 };
  }

  async resolveStudentCheckInPolicy(
    classId: number | null,
    campusId: number,
    date: Date,
  ): Promise<{ expectedCheckIn: Date | null; graceMinutes: number }> {
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
          graceMinutes: schedule.late_grace_minutes,
        };
      }
    }

    const policySets = await this.listActivePolicySets(campusId, date);
    if (policySets.length > 0) {
      return this.resolveStudentRulesFromPolicySets(policySets);
    }

    return { expectedCheckIn: null, graceMinutes: 0 };
  }

  async resolveStaffCheckInPolicy(
    employeeId: number,
    campusId: number,
    date: Date,
  ): Promise<{ expectedCheckIn: Date | null; graceMinutes: number }> {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: { reporting_time: true, late_relaxation_minutes: true },
    });

    if (employee?.reporting_time) {
      return {
        expectedCheckIn: employee.reporting_time,
        graceMinutes: employee.late_relaxation_minutes ?? 0,
      };
    }

    const policySets = await this.listActivePolicySets(campusId, date);
    if (policySets.length > 0) {
      return this.resolveStaffRulesFromPolicySets(policySets);
    }

    return { expectedCheckIn: null, graceMinutes: 0 };
  }
}
