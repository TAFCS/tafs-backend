import 'reflect-metadata';
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
import { NotFoundException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { AccessService } from './access.service';
import { UsersService } from '../users/users.service';
import { ScopeService } from '../../common/scope/scope.service';
import { EMPTY_SCOPE, type UserScope } from '../../common/scope/scope.types';

/** TAFSD-373: what a People & Access viewer must not be able to read. */
const viewer = (scope: Partial<UserScope> = {}, actions: string[] = ['system.people_access#view']) =>
  ({ sub: 'v', role: StaffRole.CAMPUS_ADMIN, userType: 'STAFF', actions, scope: { ...EMPTY_SCOPE, ...scope } }) as any;
const SA = { sub: 'sa', role: StaffRole.SUPER_ADMIN, userType: 'STAFF', actions: [], scope: EMPTY_SCOPE } as any;

const scope = new ScopeService({} as any);

describe('GET /access/users/:id/access honours the full scope', () => {
  const prisma = (user: unknown) => ({ users: { findUnique: jest.fn().mockResolvedValue(user) } });
  const target = {
    id: 't', username: 't', role: StaffRole.EMPLOYEE, campus_id: 1,
    employee_profile: { campus_id: 1, segment_id: null, department_id: 9, staff_category_id: null },
  };

  it('404s a user in the viewer\'s campus but outside their department', async () => {
    const svc = new AccessService(prisma(target) as any, {} as any, scope);
    await expect(svc.getUserAccess('t', viewer({ campuses: [1], departments: [3] }))).rejects.toThrow(NotFoundException);
  });

  it('lets a super admin past the scope check', async () => {
    const svc = new AccessService(prisma(target) as any, {} as any, scope);
    // Past the 404 it reads more tables this mock lacks; anything but NotFound means it got through.
    await expect(svc.getUserAccess('t', SA)).rejects.not.toBeInstanceOf(NotFoundException);
  });
});

describe('GET /access/scope-options offers only the viewer\'s own scope', () => {
  const rows = <T,>(r: T[]) => ({ findMany: jest.fn().mockResolvedValue(r) });
  const prisma = {
    campuses: rows([{ id: 1, campus_name: 'A', campus_code: 'A' }, { id: 2, campus_name: 'B', campus_code: 'B' }]),
    segments: rows([{ id: 5, name: 'S', code: 'S' }]),
    classes: rows([{ id: 10, description: 'C1', class_code: 'C1', segment_id: 5 }, { id: 11, description: 'C2', class_code: 'C2', segment_id: null }]),
    sections: rows([{ id: 20, description: 'X' }]),
    departments: rows([{ id: 3, name: 'Academics' }, { id: 4, name: 'Admin' }]),
    staff_categories: rows([{ id: 30, name: 'Teacher', code: 'T', department_id: 3 }, { id: 31, name: 'Clerk', code: 'C', department_id: 4 }]),
    employee_profiles: rows([]),
  };

  it('narrows campuses and departments, and categories with their department', async () => {
    const svc = new AccessService(prisma as any, {} as any, scope);
    const out = await svc.getScopeOptions(viewer({ campuses: [1], departments: [3] }));
    expect(out.campuses.map((c) => c.id)).toEqual([1]);
    expect(out.departments.map((d) => d.id)).toEqual([3]);
    expect(out.staffCategories.map((c) => c.id)).toEqual([30]);
  });

  it('shows everything to a super admin', async () => {
    const svc = new AccessService(prisma as any, {} as any, scope);
    const out = await svc.getScopeOptions(SA);
    expect(out.campuses).toHaveLength(2);
    expect(out.staffCategories).toHaveLength(2);
  });
});

describe('People & Access user list leaves pay out without schedule_pay.view', () => {
  const user = { id: 'u', campus_id: 1, employee_profile: { campus_id: 1, monthly_pay: 90000, payroll_enabled: true, job_title: 'T' } };
  const svc = (p: unknown) =>
    new UsersService({ users: { findMany: jest.fn().mockResolvedValue([p]) } } as any, {} as any, scope, {} as any);

  it('strips monthly_pay and payroll_enabled', async () => {
    const [u] = (await svc(user).listUsers(viewer())) as any[];
    expect(u.employee_profile).toEqual({ campus_id: 1, job_title: 'T' });
  });

  it('keeps them for a holder of schedule_pay.view and for a super admin', async () => {
    const [a] = (await svc(user).listUsers(viewer({}, ['hr.employee_directory#schedule_pay.view']))) as any[];
    const [b] = (await svc(user).listUsers(SA)) as any[];
    expect(a.employee_profile.monthly_pay).toBe(90000);
    expect(b.employee_profile.monthly_pay).toBe(90000);
  });
});
