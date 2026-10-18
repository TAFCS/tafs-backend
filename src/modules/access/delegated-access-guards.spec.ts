import 'reflect-metadata';
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
import { ForbiddenException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { AccessService } from './access.service';
import { AccessController } from './access.controller';
import { UsersController } from '../users/users.controller';
import { EmployeesController } from '../hr/employees/employees.controller';
import { REQUIRE_ACTION_KEY } from '../../decorators/require-action.decorator';
import { EMPTY_SCOPE } from '../../common/scope/scope.types';

/**
 * TAFSD-365. The SUPER_ADMIN decides who holds People & Access, Access Packs
 * and portal sub-permissions. Holding one lets you act on OTHER people within
 * what you hold -- never yourself, never a SUPER_ADMIN, never handing out more
 * than you have.
 */
const meta = (controller: any, handler: string) =>
  Reflect.getMetadata(REQUIRE_ACTION_KEY, controller.prototype[handler]);

describe('access-changing routes carry their sub-permission', () => {
  it.each<[any, string, string]>([
    [AccessController, 'createPack', 'system.access_packs#manage'],
    [AccessController, 'updatePack', 'system.access_packs#manage'],
    [AccessController, 'deletePack', 'system.access_packs#manage'],
    [AccessController, 'setUserAccess', 'system.people_access#view'],
    [UsersController, 'createUser', 'system.people_access#create'],
    [UsersController, 'updateUser', 'system.people_access#view'],
    [UsersController, 'revealPassword', 'system.people_access#reveal_password'],
    [UsersController, 'setPermission', 'system.people_access#access.edit'],
    [UsersController, 'removePermissionOverride', 'system.people_access#access.edit'],
    [UsersController, 'updateRolePermission', 'system.access_packs#manage'],
    [EmployeesController, 'updateAccount', 'hr.employee_directory#portal.edit'],
    [EmployeesController, 'resetAccountPassword', 'hr.employee_directory#portal.reset_password'],
    [EmployeesController, 'revealAccountPassword', 'hr.employee_directory#portal.reveal_password'],
    [EmployeesController, 'changeAccountUsername', 'hr.employee_directory#portal.change_username'],
  ])('%p.%s needs %s', (controller, handler, key) => {
    expect(meta(controller, handler)?.actionKeys).toEqual([key]);
  });
});

const SA = { sub: 'sa', role: StaffRole.SUPER_ADMIN, userType: 'STAFF' } as any;
const HR = { sub: 'hr', role: StaffRole.CAMPUS_ADMIN, userType: 'STAFF', actions: [] } as any;
const access = (tileIds: string[], actionIds: string[] = [], capabilityKeys: string[] = []) =>
  ({ tileIds, actionIds, capabilityKeys });

function service(opts: { mine?: ReturnType<typeof access>; theirs?: ReturnType<typeof access>; actorScope?: any; targetScope?: any; rolePerms?: string[] } = {}) {
  const prisma = {
    role_permissions: {
      findMany: jest.fn().mockResolvedValue((opts.rolePerms ?? []).map((key) => ({ permissions: { key } }))),
    },
  };
  const scope = {
    scopeOf: jest.fn().mockReturnValue({ ...EMPTY_SCOPE, ...(opts.actorScope ?? {}) }),
    resolve: jest.fn().mockResolvedValue({ ...EMPTY_SCOPE, ...(opts.targetScope ?? {}) }),
  };
  const svc = new AccessService(prisma as any, {} as any, scope as any);
  jest.spyOn(svc, 'resolveEffective').mockImplementation(async (id: string) =>
    id === 'hr' ? (opts.mine ?? access([])) : (opts.theirs ?? access([])),
  );
  return svc;
}

describe('assertMayManageUser', () => {
  const svc = service();
  it('refuses your own account', () => {
    expect(() => svc.assertMayManageUser(HR, { id: 'hr', role: StaffRole.CAMPUS_ADMIN })).toThrow(/your own/);
  });
  it("refuses a SUPER_ADMIN's account", () => {
    expect(() => svc.assertMayManageUser(HR, { id: 'x', role: StaffRole.SUPER_ADMIN })).toThrow(ForbiddenException);
  });
  it('allows someone else', () => {
    expect(() => svc.assertMayManageUser(HR, { id: 'x', role: StaffRole.EMPLOYEE })).not.toThrow();
  });
  it('never restricts a SUPER_ADMIN, own account included', () => {
    expect(() => svc.assertMayManageUser(SA, { id: 'sa', role: StaffRole.SUPER_ADMIN })).not.toThrow();
  });
});

describe('assertNoLeak', () => {
  it('refuses giving a tile or sub-permission you do not hold', async () => {
    const svc = service({ mine: access(['hr.employee_directory'], ['hr.employee_directory#view']) });
    await expect(
      svc.assertNoLeak(HR, access([]), access(['hr.payroll'], ['hr.payroll#view'])),
    ).rejects.toThrow(/hr\.payroll/);
  });
  it('allows giving what you hold, and taking anything away', async () => {
    const svc = service({ mine: access(['hr.payroll'], ['hr.payroll#view']) });
    await expect(svc.assertNoLeak(HR, access(['finance.vouchers']), access(['hr.payroll'], ['hr.payroll#view']))).resolves.toBeUndefined();
  });
  it('ignores what the target already had', async () => {
    const svc = service({ mine: access([]) });
    await expect(svc.assertNoLeak(HR, access(['hr.payroll']), access(['hr.payroll']))).resolves.toBeUndefined();
  });
});

describe('assertGrantableScope', () => {
  it('refuses an unrestricted dimension when your own is restricted', () => {
    const svc = service({ actorScope: { campuses: [1] } });
    expect(() => svc.assertGrantableScope(HR, { campuses: [] })).toThrow(/unrestricted/);
  });
  it('refuses ids outside your scope and allows a subset', () => {
    const svc = service({ actorScope: { campuses: [1, 2] } });
    expect(() => svc.assertGrantableScope(HR, { campuses: [3] })).toThrow(ForbiddenException);
    expect(() => svc.assertGrantableScope(HR, { campuses: [2] })).not.toThrow();
  });
});

describe('assertMayAssignRole', () => {
  it('never lets a non-super-admin give SUPER_ADMIN', async () => {
    await expect(service().assertMayAssignRole(HR, StaffRole.SUPER_ADMIN)).rejects.toThrow(ForbiddenException);
  });
  it('refuses a role carrying a capability you lack', async () => {
    const svc = service({ mine: access([], [], ['a']), rolePerms: ['a', 'b'] });
    await expect(svc.assertMayAssignRole(HR, StaffRole.PRINCIPAL)).rejects.toThrow(/b/);
  });
  it('allows a role within your capabilities', async () => {
    const svc = service({ mine: access([], [], ['a', 'b']), rolePerms: ['a'] });
    await expect(svc.assertMayAssignRole(HR, StaffRole.PRINCIPAL)).resolves.toBeUndefined();
  });
});

describe('assertNotAbove (passwords and usernames)', () => {
  it('refuses an account holding access you lack', async () => {
    const svc = service({ mine: access(['a']), theirs: access(['a', 'b']) });
    await expect(svc.assertNotAbove(HR, { id: 'x', role: StaffRole.EMPLOYEE })).rejects.toThrow(ForbiddenException);
  });
  it('refuses an account reaching outside your scope', async () => {
    const svc = service({ actorScope: { campuses: [1] }, targetScope: {} });
    await expect(svc.assertNotAbove(HR, { id: 'x', role: StaffRole.EMPLOYEE })).rejects.toThrow(/scope/);
  });
  it('allows an account at or below you', async () => {
    const svc = service({ mine: access(['a', 'b']), theirs: access(['a']), actorScope: { campuses: [1] }, targetScope: { campuses: [1] } });
    await expect(svc.assertNotAbove(HR, { id: 'x', role: StaffRole.EMPLOYEE })).resolves.toBeUndefined();
  });
});
