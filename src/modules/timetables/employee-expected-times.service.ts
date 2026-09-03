import { Injectable } from '@nestjs/common';
import { CheckInSource } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TeacherCheckinDerivationService } from './teacher-checkin-derivation.service';

export type ExpectedTimesSource = 'OVERRIDE' | 'TIMETABLE' | 'FIXED' | 'POLICY' | 'NONE';

export type ExpectedTimesResult = {
  expectedCheckIn: Date | null;
  expectedCheckOut: Date | null;
  graceMinutes: number;
  source: ExpectedTimesSource;
};

type PolicyRuleRow = {
  rule_type: string;
  value_json: unknown;
  applies_to: string | null;
};

/**
 * Single source of truth for staff expected check-in/out + late grace.
 * Used by policy resolver, staff attendance dashboard/OT, payroll, and
 * the debug expected-times endpoint.
 */
@Injectable()
export class EmployeeExpectedTimesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly derivation: TeacherCheckinDerivationService,
  ) {}

  async resolveExpectedTimes(
    employeeId: number,
    campusId: number,
    date: Date,
  ): Promise<ExpectedTimesResult> {
    const employee = await this.prisma.employee_profiles.findUnique({
      where: { id: employeeId },
      select: {
        check_in_source: true,
        reporting_time: true,
        leaving_time: true,
        late_relaxation_minutes: true,
        campus_id: true,
      },
    });

    if (!employee) {
      return {
        expectedCheckIn: null,
        expectedCheckOut: null,
        graceMinutes: 0,
        source: 'NONE',
      };
    }

    const effectiveCampusId = campusId || employee.campus_id || 0;

    const override = await this.prisma.employee_shift_overrides.findUnique({
      where: { employee_id_date: { employee_id: employeeId, date } },
    });

    // An override on only one side (start XOR end) still needs the normal
    // chain's value for the other side, so the base chain always has to run —
    // it can't be short-circuited just because an override row exists.
    const base = await this.resolveBaseChain(employee, employeeId, effectiveCampusId, date);

    if (!override || (override.override_start_time == null && override.override_end_time == null)) {
      return base;
    }

    return {
      expectedCheckIn: override.override_start_time ?? base.expectedCheckIn,
      expectedCheckOut: override.override_end_time ?? base.expectedCheckOut,
      graceMinutes: base.graceMinutes,
      source: 'OVERRIDE',
    };
  }

  private async resolveBaseChain(
    employee: {
      check_in_source: CheckInSource;
      reporting_time: Date | null;
      leaving_time: Date | null;
      late_relaxation_minutes: number | null;
      campus_id: number | null;
    },
    employeeId: number,
    effectiveCampusId: number,
    date: Date,
  ): Promise<ExpectedTimesResult> {
    if (employee.check_in_source === CheckInSource.TIMETABLE) {
      const derived = await this.derivation.resolveForDate(employeeId, date);
      if (derived) {
        const graceMinutes = await this.resolveGraceMinutes(
          employee.late_relaxation_minutes,
          effectiveCampusId,
          date,
        );
        return {
          expectedCheckIn: derived.checkIn,
          expectedCheckOut: derived.checkOut,
          graceMinutes,
          source: 'TIMETABLE',
        };
      }
      // No slots that weekday → return NONE
      return {
        expectedCheckIn: null,
        expectedCheckOut: null,
        graceMinutes: 0,
        source: 'NONE',
      };
    }

    return this.resolveFixedOrPolicy(employee, effectiveCampusId, date);
  }

  private async resolveFixedOrPolicy(
    employee: {
      reporting_time: Date | null;
      leaving_time: Date | null;
      late_relaxation_minutes: number | null;
    },
    campusId: number,
    date: Date,
  ): Promise<ExpectedTimesResult> {
    if (employee.reporting_time) {
      return {
        expectedCheckIn: employee.reporting_time,
        expectedCheckOut: employee.leaving_time,
        graceMinutes: employee.late_relaxation_minutes ?? 0,
        source: 'FIXED',
      };
    }

    if (campusId) {
      const policy = await this.resolveStaffPolicyCheckIn(campusId, date);
      if (policy.expectedCheckIn) {
        return {
          expectedCheckIn: policy.expectedCheckIn,
          expectedCheckOut: employee.leaving_time,
          graceMinutes:
            employee.late_relaxation_minutes ?? policy.graceMinutes,
          source: 'POLICY',
        };
      }
    }

    return {
      expectedCheckIn: null,
      expectedCheckOut: employee.leaving_time,
      graceMinutes: employee.late_relaxation_minutes ?? 0,
      source: employee.leaving_time ? 'FIXED' : 'NONE',
    };
  }

  private async resolveGraceMinutes(
    employeeGrace: number | null,
    campusId: number,
    date: Date,
  ): Promise<number> {
    if (employeeGrace != null) return employeeGrace;
    if (!campusId) return 0;
    const policy = await this.resolveStaffPolicyCheckIn(campusId, date);
    return policy.graceMinutes;
  }

  private async resolveStaffPolicyCheckIn(
    campusId: number,
    date: Date,
  ): Promise<{ expectedCheckIn: Date | null; graceMinutes: number }> {
    const sets = await this.prisma.hr_policy_sets.findMany({
      where: {
        campus_id: campusId,
        effective_from: { lte: date },
      },
      orderBy: { effective_from: 'desc' },
      include: { hr_policy_rules: true },
    });

    for (const set of sets) {
      const rules = set.hr_policy_rules as PolicyRuleRow[];
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
   * Batched equivalent of the per-date override lookup in resolveExpectedTimes(),
   * for callers (payroll) that walk many employees x many days and can't afford
   * one query per employee per day. Keyed by employee then YYYY-MM-DD.
   */
  async loadShiftOverridesForEmployees(
    employeeIds: number[],
    dateFrom: Date,
    dateTo: Date,
  ): Promise<Map<number, Map<string, { start: Date | null; end: Date | null }>>> {
    const map = new Map<number, Map<string, { start: Date | null; end: Date | null }>>();
    if (employeeIds.length === 0) return map;

    const rows = await this.prisma.employee_shift_overrides.findMany({
      where: { employee_id: { in: employeeIds }, date: { gte: dateFrom, lte: dateTo } },
      select: { employee_id: true, date: true, override_start_time: true, override_end_time: true },
    });

    for (const row of rows) {
      const key = row.date.toISOString().slice(0, 10);
      const inner = map.get(row.employee_id) ?? new Map();
      inner.set(key, { start: row.override_start_time, end: row.override_end_time });
      map.set(row.employee_id, inner);
    }
    return map;
  }
}
