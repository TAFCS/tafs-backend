import 'reflect-metadata';

// uuid ships ESM that jest here does not transform; nothing below generates an id.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
jest.mock('@react-pdf/renderer', () => ({ renderToBuffer: jest.fn() }));

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StaffRole } from '@prisma/client';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { REQUIRE_ACTION_KEY, type RequireActionMetadata } from '../../decorators/require-action.decorator';
import { computeEffectiveAccess } from './access.effective';
import { MANIFEST_EFFECTIVE_TILES, TILES_MANIFEST } from './tiles.manifest';
import { EmployeesController } from '../hr/employees/employees.controller';
import { EmployeesService } from '../hr/employees/employees.service';
import { StudentsController } from '../students/students.controller';

/**
 * TAFSD-191..204: a user delegated ONE tile must be able to load the lookups
 * that tile's page needs (an employee dropdown, a student search) without being
 * handed the Employee or Student Directory.
 */

const allKeys = [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))];

function tokenHolding(tileId: string) {
  const r = computeEffectiveAccess({
    role: StaffRole.EMPLOYEE,
    allPermissionKeys: allKeys,
    activeTiles: MANIFEST_EFFECTIVE_TILES,
    roleKeys: [],
    packTileIds: [],
    allowTileIds: [tileId],
    denyTileIds: [],
    userPerms: [],
  });
  return {
    sub: 'u',
    username: 'u',
    role: StaffRole.EMPLOYEE,
    campusId: null,
    allowedClassIds: [],
    userType: 'STAFF' as const,
    permissions: r.capabilityKeys,
    actions: r.actionIds,
  };
}

function allows(controller: { prototype: object }, handler: string, user: unknown): boolean {
  const meta: RequireActionMetadata = Reflect.getMetadata(REQUIRE_ACTION_KEY, (controller.prototype as any)[handler]);
  const reflector = { getAllAndOverride: () => meta } as unknown as Reflector;
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  try {
    return new TileActionGuard(reflector).canActivate(ctx);
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
}

// page tile -> the lookups its page calls
const EMPLOYEE_PICKER_TILES = [
  'hr.departments', // 193
  'hr.payroll', // 191
  'attendance.academic_calendar', // 192
  'attendance.saturday_schedules', // 194
  'attendance.shift_overrides', // 195
  'attendance.teaching_groups', // 196
  'attendance.timetables', // 197
];
const EMPLOYEE_SEARCH_TILES = [
  'hr.employee_loans', // 198
  'hr.security_deposits', // 199
  'attendance.teaching_groups', // 196
  'attendance.timetables',
  'attendance.saturday_schedules',
  'attendance.shift_overrides',
];
const STUDENT_SEARCH_TILES = [
  'attendance.teaching_groups', // 196
  'attendance.quick_check_in', // 200
  'attendance.student_attendance', // 201
  'communication.notice_board', // 202
  'student.families', // 203
  'student.enrollments', // 204
];
const STUDENT_LIST_TILES = ['student.families', 'attendance.teaching_groups']; // 203, 196

describe.each([
  ['GET /hr/employees/picker', EmployeesController, 'listPicker', EMPLOYEE_PICKER_TILES],
  ['GET /hr/employees/search-simple', EmployeesController, 'searchSimple', EMPLOYEE_SEARCH_TILES],
  ['GET /students/search-simple', StudentsController, 'searchSimple', STUDENT_SEARCH_TILES],
  ['GET /students', StudentsController, 'findAll', STUDENT_LIST_TILES],
])('%s', (_label, controller, handler, tiles) => {
  it.each(tiles)('opens for a user holding ONLY %s', (tileId) => {
    expect(TILES_MANIFEST.some((t) => t.id === tileId)).toBe(true);
    expect(allows(controller, handler, tokenHolding(tileId))).toBe(true);
  });

  it('stays closed to a user holding no tile, even with every role capability', () => {
    const user = { ...tokenHolding('none.none'), permissions: allKeys, actions: [] };
    expect(allows(controller, handler, user)).toBe(false);
  });

  it('stays closed to a tile that has no business with it', () => {
    expect(allows(controller, handler, tokenHolding('finance.postdated_cheques'))).toBe(
      handler === 'searchSimple' && controller === StudentsController,
    );
  });
});

describe('EmployeesService.listPicker', () => {
  it('never selects CNIC, pay, phone or schedule, and reduces pay to a flag', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 1, full_name: 'A', monthly_pay: 50000, campus_id: 1 },
      { id: 2, full_name: 'B', monthly_pay: null, campus_id: 1 },
    ]);
    const scope = { whereForEmployees: jest.fn().mockReturnValue({ campus_id: { in: [1] } }) };
    const service = Object.create(EmployeesService.prototype) as any;
    service.prisma = { employee_profiles: { findMany } };
    service.scope = scope;

    const rows = await service.listPicker({ role: StaffRole.EMPLOYEE });

    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({ campus_id: { in: [1] } });
    for (const sensitive of ['cnic', 'personal_phone', 'reporting_time', 'leaving_time', 'join_date']) {
      expect(args.select).not.toHaveProperty(sensitive);
    }
    expect(rows).toEqual([
      { id: 1, full_name: 'A', campus_id: 1, has_monthly_pay: true },
      { id: 2, full_name: 'B', campus_id: 1, has_monthly_pay: false },
    ]);
    expect(rows[0]).not.toHaveProperty('monthly_pay');
  });
});
