import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { ReportingHierarchyService } from './reporting-hierarchy.service';

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  full_name: `P${id}`,
  campus_id: 1,
  department_id: 6,
  employment_status: 'ACTIVE',
  ...over,
});

function mk(people: ReturnType<typeof row>[]) {
  const tx = {
    employee_reporting_lines: {
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(),
      create: jest.fn(),
    },
    employee_profiles: {
      update: jest.fn(async ({ where }: any) => ({
        ...people.find((p) => p.id === where.id),
        employee_class_section_assignments: [],
      })),
    },
  };
  const prisma = {
    employee_profiles: {
      findUnique: jest.fn(async ({ where }: any) => people.find((p) => p.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: any) => people.filter((p) => where.id.in.includes(p.id))),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const audit = { log: jest.fn() };
  const progression = { recordProgressionChange: jest.fn() };
  const scope = {
    isHierarchyEnforced: jest.fn().mockResolvedValue(false),
    setHierarchyEnforced: jest.fn().mockResolvedValue(true),
    invalidateScopeCache: jest.fn(),
  };
  const svc = new ReportingHierarchyService(prisma as any, audit as any, progression as any, scope as any);
  return { svc, tx, audit, progression, scope };
}

const superAdmin = { sub: 'u1', username: 'sa', role: StaffRole.SUPER_ADMIN } as any;
const campusAdmin = { sub: 'u2', username: 'ca', role: StaffRole.CAMPUS_ADMIN } as any;

describe('ReportingHierarchyService', () => {
  it('refuses everyone but SUPER_ADMIN, for reading and writing', async () => {
    const { svc } = mk([row(1), row(2)]);
    await expect(svc.getTree(campusAdmin)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setManagers(1, { manager_ids: [2] }, campusAdmin)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('saves the lines in order, mirrors the first onto reporting_manager_id and records progression', async () => {
    const { svc, tx, progression, audit } = mk([row(1), row(2), row(3)]);
    await svc.setManagers(1, { manager_ids: [3, 2, 3] }, superAdmin);
    expect(tx.employee_reporting_lines.deleteMany).toHaveBeenCalledWith({ where: { employee_id: 1 } });
    expect(tx.employee_reporting_lines.create.mock.calls.map((c) => c[0].data.manager_id)).toEqual([3, 2]);
    expect(tx.employee_profiles.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reporting_manager_id: 3 } }),
    );
    expect(progression.recordProgressionChange).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalled();
  });

  it('places no structural rules: other department, other campus, a peer, anyone', async () => {
    const { svc, tx } = mk([row(1), row(2, { department_id: 10, campus_id: 3 }), row(3)]);
    await svc.setManagers(1, { manager_ids: [2, 3] }, superAdmin);
    expect(tx.employee_reporting_lines.create).toHaveBeenCalledTimes(2);
  });

  it('clears every line when given none', async () => {
    const { svc, tx } = mk([row(1)]);
    await svc.setManagers(1, { manager_ids: [] }, superAdmin);
    expect(tx.employee_reporting_lines.create).not.toHaveBeenCalled();
    expect(tx.employee_profiles.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reporting_manager_id: null } }),
    );
  });

  it('refuses people who do not exist or have left', async () => {
    const { svc } = mk([row(1), row(2, { employment_status: 'LEFT' })]);
    await expect(svc.setManagers(1, { manager_ids: [9] }, superAdmin)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.setManagers(1, { manager_ids: [2] }, superAdmin)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows super admin to toggle enforcement and logs to audit', async () => {
    const { svc, audit, scope } = mk([row(1)]);
    await expect(svc.setEnforcement(true, campusAdmin)).rejects.toBeInstanceOf(ForbiddenException);

    const res = await svc.setEnforcement(true, superAdmin);
    expect(res).toEqual({ enforced: true });
    expect(scope.setHierarchyEnforced).toHaveBeenCalledWith(true, 'u1');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'APP_CONFIG',
        entity_id: 'enforce_reporting_hierarchy',
        new_value: 'true',
      }),
    );
  });

  describe('getMismatches', () => {
    it('refuses non super-admin', async () => {
      const { svc } = mk([row(1)]);
      await expect(svc.getMismatches(campusAdmin)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('flags report whose campus is outside manager scope', async () => {
      const people = [
        row(1, { user_id: 'u-mgr', full_name: 'Manager Bob' }),
        row(2, { user_id: 'u-rep', full_name: 'Report Alice', campus_id: 2 }),
      ];
      const { svc, scope } = mk(people);
      // Manager is scoped only to campus 1
      scope.resolveEffective = jest.fn().mockResolvedValue({
        campuses: [1],
        segments: [],
        classes: [],
        sections: [],
        departments: [],
        staffCategories: [],
      });

      // Prisma mocks for getMismatches
      (svc as any).prisma.employee_reporting_lines = {
        findMany: jest.fn().mockResolvedValue([{ manager_id: 1, employee_id: 2 }]),
      };
      (svc as any).prisma.employee_profiles.findMany = jest.fn().mockResolvedValue(people);
      (svc as any).prisma.campuses = {
        findMany: jest.fn().mockResolvedValue([
          { id: 1, campus_name: 'Campus One' },
          { id: 2, campus_name: 'Campus Two' },
        ]),
      };
      (svc as any).prisma.segments = { findMany: jest.fn().mockResolvedValue([]) };
      (svc as any).prisma.departments = { findMany: jest.fn().mockResolvedValue([]) };
      (svc as any).prisma.ticket_queues = { findMany: jest.fn().mockResolvedValue([]) };
      (svc as any).prisma.ticket_routing_rules = { findMany: jest.fn().mockResolvedValue([]) };
      (svc as any).prisma.users = {
        findUnique: jest.fn().mockResolvedValue({ id: 'u-mgr', role: StaffRole.CAMPUS_ADMIN }),
      };

      const report = await svc.getMismatches(superAdmin);
      expect(report.managerReportMismatches).toHaveLength(1);
      expect(report.managerReportMismatches[0]).toMatchObject({
        managerId: 1,
        reportId: 2,
        mismatchedDimensions: ['campus'],
      });
      expect(report.totalMismatches).toBe(1);
    });
  });
});
