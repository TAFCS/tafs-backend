import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { ReportingHierarchyService } from './reporting-hierarchy.service';

const ACADEMICS = 6;
const ADMIN = 10;

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  full_name: `P${id}`,
  employee_code: null,
  job_title: null,
  campus_id: 1,
  department_id: ACADEMICS,
  staff_category_id: 1,
  photo_url: null,
  employment_status: 'ACTIVE',
  staff_categories: { code: 'TEACHER' },
  ...over,
});

function mk(people: ReturnType<typeof row>[], lines: { employee_id: number; manager_id: number }[] = []) {
  const tx = {
    employee_reporting_lines: { deleteMany: jest.fn(), createMany: jest.fn() },
    employee_profiles: {
      update: jest.fn(async ({ where }: any) => ({ ...people.find((p) => p.id === where.id), employee_class_section_assignments: [] })),
    },
  };
  const prisma = {
    employee_profiles: {
      findUnique: jest.fn(async ({ where }: any) => people.find((p) => p.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) => people.filter((p) => where.id.in.includes(p.id))),
    },
    employee_reporting_lines: { findMany: jest.fn(async () => lines) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const audit = { log: jest.fn() };
  const progression = { recordProgressionChange: jest.fn() };
  const svc = new ReportingHierarchyService(prisma as any, audit as any, progression as any);
  return { svc, tx, audit, progression };
}

const superAdmin = { sub: 'u1', username: 'sa', role: StaffRole.SUPER_ADMIN } as any;
const campusAdmin = { sub: 'u2', username: 'ca', role: StaffRole.CAMPUS_ADMIN } as any;

describe('ReportingHierarchyService', () => {
  it('refuses everyone but SUPER_ADMIN, for reading and writing', async () => {
    const { svc } = mk([row(1), row(2)]);
    await expect(svc.getTree(campusAdmin)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setManagers(1, { manager_ids: [2] }, campusAdmin)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('saves the lines, mirrors the primary onto reporting_manager_id and records progression', async () => {
    const lead = { staff_categories: { code: 'SENIOR_LEADERSHIP' }, department_id: ADMIN };
    const { svc, tx, progression, audit } = mk([row(1), row(2, lead), row(3, lead)]);
    await svc.setManagers(1, { manager_ids: [2, 3], primary_manager_id: 3 }, superAdmin);
    expect(tx.employee_reporting_lines.deleteMany).toHaveBeenCalledWith({ where: { employee_id: 1 } });
    expect(tx.employee_reporting_lines.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ employee_id: 1, manager_id: 2, is_primary: false }),
      expect.objectContaining({ employee_id: 1, manager_id: 3, is_primary: true }),
    ]);
    expect(tx.employee_profiles.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reporting_manager_id: 3 } }),
    );
    expect(progression.recordProgressionChange).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalled();
  });

  it('clears every line when given none', async () => {
    const { svc, tx } = mk([row(1)]);
    await svc.setManagers(1, { manager_ids: [] }, superAdmin);
    expect(tx.employee_reporting_lines.createMany).not.toHaveBeenCalled();
    expect(tx.employee_profiles.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reporting_manager_id: null } }),
    );
  });

  it('refuses a manager from another department, naming them', async () => {
    const { svc, tx } = mk([row(1), row(2, { department_id: ADMIN })]);
    await expect(svc.setManagers(1, { manager_ids: [2] }, superAdmin)).rejects.toThrow(/P2 is not in the same department/);
    expect(tx.employee_reporting_lines.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a loop', async () => {
    const { svc } = mk([row(1), row(2)], [{ employee_id: 2, manager_id: 1 }]);
    await expect(svc.setManagers(1, { manager_ids: [2] }, superAdmin)).rejects.toThrow(/already reports to P1/);
  });

  it('refuses self and a primary that is not one of the managers', async () => {
    const { svc } = mk([row(1), row(2)]);
    await expect(svc.setManagers(1, { manager_ids: [1] }, superAdmin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setManagers(1, { manager_ids: [2], primary_manager_id: 3 }, superAdmin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
