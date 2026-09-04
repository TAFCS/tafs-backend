import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type PrismaTx = Prisma.TransactionClient;

export type ClassSectionSnapshot = { class_id: number; section_id: number | null };

/** The employment state that is tracked over time. */
export type EmployeeProgressionSnapshot = {
  campusId: number | null;
  segmentId: number | null;
  departmentId: number | null;
  staffCategoryId: number | null;
  reportingManagerId: number | null;
  jobTitle: string | null;
  employmentType: string | null;
  employmentStatus: string;
  monthlyPay: Prisma.Decimal | string | number | null;
  payrollEnabled: boolean;
  classSections: ClassSectionSnapshot[];
};

export type EmployeeProgressionChangeParams = EmployeeProgressionSnapshot & {
  employeeId: number;
  changeType: string;
  changedBy: string | null;
  notes?: string | null;
  /** Override timestamp (used by the backfill). Defaults to now. */
  at?: Date;
};

/** Stable string form of a class/section assignment set, order-independent. */
function normalizeClassSections(rows: unknown): string {
  if (!Array.isArray(rows)) return '[]';
  const cleaned = rows
    .map((r) => ({
      class_id: Number((r as ClassSectionSnapshot)?.class_id),
      section_id:
        (r as ClassSectionSnapshot)?.section_id == null
          ? null
          : Number((r as ClassSectionSnapshot).section_id),
    }))
    .filter((r) => Number.isFinite(r.class_id))
    .sort(
      (a, b) =>
        a.class_id - b.class_id || (a.section_id ?? -1) - (b.section_id ?? -1),
    );
  return JSON.stringify(cleaned);
}

/** Money values arrive as Decimal | string | number | null; compare as strings. */
function normalizeMoney(value: EmployeeProgressionSnapshot['monthlyPay']): string {
  if (value == null) return '';
  return String(value);
}

function snapshotsEqual(
  a: EmployeeProgressionSnapshot,
  b: EmployeeProgressionSnapshot,
): boolean {
  return (
    a.campusId === b.campusId &&
    a.segmentId === b.segmentId &&
    a.departmentId === b.departmentId &&
    a.staffCategoryId === b.staffCategoryId &&
    a.reportingManagerId === b.reportingManagerId &&
    (a.jobTitle ?? null) === (b.jobTitle ?? null) &&
    (a.employmentType ?? null) === (b.employmentType ?? null) &&
    a.employmentStatus === b.employmentStatus &&
    normalizeMoney(a.monthlyPay) === normalizeMoney(b.monthlyPay) &&
    a.payrollEnabled === b.payrollEnabled &&
    normalizeClassSections(a.classSections) ===
      normalizeClassSections(b.classSections)
  );
}

function openPeriodToSnapshot(open: {
  campus_id: number | null;
  segment_id: number | null;
  department_id: number | null;
  staff_category_id: number | null;
  reporting_manager_id: number | null;
  job_title: string | null;
  employment_type: string | null;
  employment_status: string;
  monthly_pay: Prisma.Decimal | null;
  payroll_enabled: boolean;
  class_sections: Prisma.JsonValue | null;
}): EmployeeProgressionSnapshot {
  return {
    campusId: open.campus_id,
    segmentId: open.segment_id,
    departmentId: open.department_id,
    staffCategoryId: open.staff_category_id,
    reportingManagerId: open.reporting_manager_id,
    jobTitle: open.job_title,
    employmentType: open.employment_type,
    employmentStatus: open.employment_status,
    monthlyPay: open.monthly_pay,
    payrollEnabled: open.payroll_enabled,
    classSections: Array.isArray(open.class_sections)
      ? (open.class_sections as unknown as ClassSectionSnapshot[])
      : [],
  };
}

@Injectable()
export class EmployeeProgressionService {
  /**
   * Close the employee's open employment period (if any) and open a new one
   * when any tracked field actually changed. No-op otherwise.
   */
  async recordProgressionChange(
    tx: PrismaTx,
    params: EmployeeProgressionChangeParams,
  ): Promise<void> {
    const open = await tx.employee_progression_periods.findFirst({
      where: { employee_id: params.employeeId, valid_to: null },
    });

    if (open && snapshotsEqual(openPeriodToSnapshot(open), params)) {
      return;
    }

    const now = params.at ?? new Date();

    if (open) {
      await tx.employee_progression_periods.update({
        where: { id: open.id },
        data: { valid_to: now },
      });
    }

    await tx.employee_progression_periods.create({
      data: {
        employee_id: params.employeeId,
        campus_id: params.campusId,
        segment_id: params.segmentId,
        department_id: params.departmentId,
        staff_category_id: params.staffCategoryId,
        reporting_manager_id: params.reportingManagerId,
        job_title: params.jobTitle,
        employment_type: params.employmentType,
        employment_status: params.employmentStatus,
        monthly_pay: params.monthlyPay ?? null,
        payroll_enabled: params.payrollEnabled,
        class_sections: params.classSections as unknown as Prisma.InputJsonValue,
        change_type: params.changeType,
        changed_by: params.changedBy,
        notes: params.notes ?? null,
        valid_from: now,
        valid_to: null,
      },
    });
  }

  /**
   * Pick a specific label when exactly one dimension changed, else `defaultType`.
   */
  resolveChangeType(params: {
    prior: EmployeeProgressionSnapshot | null;
    next: EmployeeProgressionSnapshot;
    defaultType: string;
  }): string {
    const { prior, next, defaultType } = params;
    if (!prior) return defaultType;

    const payChanged =
      normalizeMoney(prior.monthlyPay) !== normalizeMoney(next.monthlyPay) ||
      prior.payrollEnabled !== next.payrollEnabled;
    const statusChanged = prior.employmentStatus !== next.employmentStatus;
    const segmentChanged = prior.segmentId !== next.segmentId;
    const campusChanged = prior.campusId !== next.campusId;
    const classesChanged =
      normalizeClassSections(prior.classSections) !==
      normalizeClassSections(next.classSections);
    const otherChanged =
      prior.departmentId !== next.departmentId ||
      prior.staffCategoryId !== next.staffCategoryId ||
      prior.reportingManagerId !== next.reportingManagerId ||
      (prior.jobTitle ?? null) !== (next.jobTitle ?? null) ||
      (prior.employmentType ?? null) !== (next.employmentType ?? null);

    const changedDimensions = [
      payChanged,
      statusChanged,
      segmentChanged,
      campusChanged,
      classesChanged,
      otherChanged,
    ].filter(Boolean).length;

    if (changedDimensions !== 1) return defaultType;

    if (payChanged) return 'PAY_CHANGED';
    if (statusChanged) return 'STATUS_CHANGED';
    if (segmentChanged) return 'SEGMENT_CHANGED';
    if (campusChanged) return 'TRANSFERRED';
    if (classesChanged) return 'CLASS_REASSIGNED';
    return defaultType;
  }
}
