import 'reflect-metadata';
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
import { AccessController } from './access.controller';
import { UsersController } from '../users/users.controller';
import { EmployeesController } from '../hr/employees/employees.controller';
import { TILES_MANIFEST } from './tiles.manifest';
import { REQUIRE_ACTION_KEY } from '../../decorators/require-action.decorator';

/**
 * TAFSD-365: only a SUPER_ADMIN changes who may do what. Every route that
 * writes a login's role, tiles, packs, sub-permissions, capability overrides,
 * scope or credentials must carry @RequireSuperAdmin. Adding a write to one of
 * these controllers without it fails here.
 */
const mode = (controller: any, handler: string) =>
  Reflect.getMetadata(REQUIRE_ACTION_KEY, controller.prototype[handler])?.mode;

describe('access-changing routes are SUPER_ADMIN only', () => {
  it.each<[string, any, string]>([
    ['access', AccessController, 'createPack'],
    ['access', AccessController, 'updatePack'],
    ['access', AccessController, 'deletePack'],
    ['access', AccessController, 'setUserAccess'],
    ['users', UsersController, 'createUser'],
    ['users', UsersController, 'updateUser'],
    ['users', UsersController, 'revealPassword'],
    ['users', UsersController, 'setPermission'],
    ['users', UsersController, 'removePermissionOverride'],
    ['users', UsersController, 'updateRolePermission'],
    ['employees', EmployeesController, 'updateAccount'],
    ['employees', EmployeesController, 'resetAccountPassword'],
    ['employees', EmployeesController, 'revealAccountPassword'],
    ['employees', EmployeesController, 'changeAccountUsername'],
  ])('%s.%s', (_c, controller, handler) => {
    expect(mode(controller, handler)).toBe('super_admin');
  });

  it('leaves People & Access and Access Packs with nothing to delegate but view', () => {
    for (const id of ['system.people_access', 'system.access_packs']) {
      const tile = TILES_MANIFEST.find((t) => t.id === id)!;
      expect(tile.actions!.map((a) => a.id)).toEqual(['view']);
    }
  });

  it('retires the Employee Directory portal write actions', () => {
    const ids = TILES_MANIFEST.find((t) => t.id === 'hr.employee_directory')!.actions!.map((a) => a.id);
    for (const retired of ['portal.edit', 'portal.reset_password', 'portal.change_username', 'portal.reveal_password']) {
      expect(ids).not.toContain(retired);
    }
  });
});
