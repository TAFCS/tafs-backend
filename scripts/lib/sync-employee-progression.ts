/**
 * Shared helper for ops scripts: snapshot current employee state into
 * employee_progression_periods after mutating tracked fields.
 */
import { PrismaClient } from '@prisma/client';
import {
  EmployeeProgressionService,
  type EmployeeProgressionSnapshot,
} from '../../src/modules/hr/employees/employee-progression.service';

const progression = new EmployeeProgressionService();

export async function syncEmployeeProgressionFromDb(
  prisma: PrismaClient,
  employeeId: number,
  opts?: { changeType?: string; changedBy?: string; defaultType?: string },
): Promise<void> {
  const emp = await prisma.employee_profiles.findUnique({
    where: { id: employeeId },
    include: {
      employee_class_section_assignments: {
        select: { class_id: true, section_id: true },
      },
    },
  });
  if (!emp) return;

  const snapshot: EmployeeProgressionSnapshot = {
    campusId: emp.campus_id,
    segmentId: emp.segment_id,
    departmentId: emp.department_id,
    staffCategoryId: emp.staff_category_id,
    reportingManagerId: emp.reporting_manager_id,
    jobTitle: emp.job_title,
    employmentType: emp.employment_type,
    employmentStatus: emp.employment_status,
    monthlyPay: emp.monthly_pay,
    payrollEnabled: emp.payroll_enabled,
    classSections: emp.employee_class_section_assignments.map((a) => ({
      class_id: a.class_id,
      section_id: a.section_id ?? null,
    })),
  };

  const open = await prisma.employee_progression_periods.findFirst({
    where: { employee_id: employeeId, valid_to: null },
  });

  const priorSnapshot = open
    ? {
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
          ? (open.class_sections as { class_id: number; section_id: number | null }[])
          : [],
      }
    : null;

  const changeType =
    opts?.changeType ??
    progression.resolveChangeType({
      prior: priorSnapshot,
      next: snapshot,
      defaultType: opts?.defaultType ?? (open ? 'REASSIGNED' : 'ONBOARDED'),
    });

  await prisma.$transaction(async (tx) => {
    await progression.recordProgressionChange(tx, {
      employeeId,
      ...snapshot,
      changeType,
      changedBy: opts?.changedBy ?? 'script',
    });
  });
}
