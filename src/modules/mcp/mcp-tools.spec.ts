import 'reflect-metadata';

// uuid ships ESM that jest here does not transform; nothing below generates an id.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StaffRole } from '@prisma/client';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import { TILES_MANIFEST } from '../access/tiles.manifest';
import {
  computeEffectiveAccess,
  type EffectiveTile,
} from '../access/access.effective';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { McpRouteAccess } from './mcp-access';
import { MCP_TOOLS } from './mcp-tools';
import { McpService } from './mcp.service';
import { capResult, summarizeArgs } from './mcp-result';
import { StudentsController } from '../students/students.controller';

const effectiveTiles: EffectiveTile[] = TILES_MANIFEST.map((t) => ({
  id: t.id,
  capabilities: t.capabilities,
  actions: t.actions?.map((a) => ({
    id: a.id,
    default: !!a.default,
    implies: a.implies ?? [],
  })),
  legacyFullAccessCapabilities: t.legacyFullAccessCapabilities,
  requiresExplicitAllow: (t.surface ?? 'web') === 'web',
}));
const allKeys = [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))];

/** A principal built the way login / JwtStaffStrategy build it. */
function principal(opts: {
  role?: StaffRole;
  allowTileIds?: string[];
  actionGrants?: { tileId: string; actionId: string; allow: boolean }[];
}): IJwtStaffPayload {
  const r = computeEffectiveAccess({
    role: opts.role ?? StaffRole.EMPLOYEE,
    allPermissionKeys: allKeys,
    activeTiles: effectiveTiles,
    roleKeys: [],
    packTileIds: [],
    allowTileIds: opts.allowTileIds ?? [],
    denyTileIds: [],
    userPerms: [],
    userActionGrants: opts.actionGrants ?? [],
  });
  return {
    sub: 'u',
    username: 'u',
    role: opts.role ?? StaffRole.EMPLOYEE,
    campusId: null,
    allowedClassIds: [],
    userType: 'STAFF',
    permissions: r.capabilityKeys,
    actions: r.actionIds,
  };
}

function service(controllers: Record<string, unknown> = {}) {
  const audit = { log: jest.fn().mockResolvedValue(1) };
  const moduleRef = {
    get: jest.fn((cls: { name: string }) => {
      const c = controllers[cls.name];
      if (!c) throw new Error(`no ${cls.name}`);
      return c;
    }),
  };
  const svc = new McpService(
    moduleRef as never,
    new Reflector(),
    new CaslAbilityFactory(),
    audit as never,
  );
  return { svc, audit, moduleRef };
}

const names = (svc: McpService, user: IJwtStaffPayload) =>
  svc
    .visibleTools(user)
    .map((t) => t.name)
    .sort();

describe('MCP tool registry (TAFSD-531)', () => {
  it('mirrors only routes that exist and sit behind the staff JWT and both permission guards', () => {
    for (const tool of MCP_TOOLS) {
      if (tool.route === null) {
        expect(tool.name).toBe('whoami');
        continue;
      }
      expect(
        typeof (tool.route.controller.prototype as Record<string, unknown>)[
          tool.route.method
        ],
      ).toBe('function');
      expect(McpRouteAccess.isMirrorable(tool.route)).toBe(true);
    }
  });

  it('has unique names and object input schemas', () => {
    expect(new Set(MCP_TOOLS.map((t) => t.name)).size).toBe(MCP_TOOLS.length);
    for (const t of MCP_TOOLS) expect(t.inputSchema.type).toBe('object');
  });
});

describe('MCP tools/list follows the caller’s grants', () => {
  const { svc } = service();

  it('a SUPER_ADMIN sees every tool', () => {
    expect(names(svc, principal({ role: StaffRole.SUPER_ADMIN }))).toEqual(
      MCP_TOOLS.map((t) => t.name).sort(),
    );
  });

  it('someone holding no data tile sees only whoami', () => {
    expect(
      names(svc, principal({ allowTileIds: ['system.ai_assistant'] })),
    ).toEqual(['whoami']);
  });

  it('a Student Directory user sees student tools, not finance ones', () => {
    expect(
      names(
        svc,
        principal({
          allowTileIds: ['system.ai_assistant', 'student.directory'],
        }),
      ),
    ).toEqual(['get_student', 'search_students', 'whoami']);
  });

  it('a Vouchers user sees vouchers and student search, not the student profile or defaulters', () => {
    expect(
      names(
        svc,
        principal({
          allowTileIds: ['system.ai_assistant', 'finance.vouchers'],
        }),
      ),
    ).toEqual(['get_voucher', 'list_vouchers', 'search_students', 'whoami']);
  });

  it('defaulters follows the Defaulters tab sub-permission of Financial Reports', () => {
    const withTab = principal({ allowTileIds: ['finance.financial_reports'] });
    const tabDenied = principal({
      allowTileIds: ['finance.financial_reports'],
      actionGrants: [
        {
          tileId: 'finance.financial_reports',
          actionId: 'defaulters.view',
          allow: false,
        },
      ],
    });
    expect(names(svc, withTab)).toContain('list_defaulters');
    expect(names(svc, tabDenied)).not.toContain('list_defaulters');
    // The arrears tool mirrors /vouchers/arrears, which only Single Voucher Issuance opens.
    expect(names(svc, withTab)).not.toContain('get_student_arrears');
    expect(
      names(svc, principal({ allowTileIds: ['finance.single_voucher'] })),
    ).toContain('get_student_arrears');
  });

  it('a denied sub-permission removes the tool even when the tile is held', () => {
    const user = principal({
      allowTileIds: ['student.directory', 'finance.payment_history'],
      actionGrants: [
        { tileId: 'finance.payment_history', actionId: 'view', allow: false },
      ],
    });
    // Payment history route takes student.directory#payment_history.view OR finance.payment_history#view.
    const both = principal({
      allowTileIds: ['student.directory', 'finance.payment_history'],
    });
    expect(names(svc, both)).toContain('get_student_payment_history');
    expect(names(svc, user)).not.toContain('get_student_payment_history');
  });

  it('an HR user sees employee search only', () => {
    expect(
      names(svc, principal({ allowTileIds: ['hr.employee_directory'] })),
    ).toEqual(['search_employees', 'search_students', 'whoami']);
  });

  it('a parent principal sees nothing', () => {
    const parent = {
      sub: 1,
      familyId: 1,
      userType: 'PARENT',
    } as unknown as IJwtStaffPayload;
    expect(svc.visibleTools(parent).filter((t) => t.route !== null)).toEqual(
      [],
    );
  });
});

describe('MCP tools/call re-checks access and audits', () => {
  const directory = principal({ allowTileIds: ['student.directory'] });

  it('refuses a tool the caller may not use exactly like an unknown one, without running it', async () => {
    const vouchers = { findAll: jest.fn() };
    const { svc, audit } = service({ VouchersController: vouchers });
    const denied = svc.callTool(directory, 'list_vouchers', {}, 'tok-1');
    await expect(denied).rejects.toBeInstanceOf(McpError);
    await expect(
      svc.callTool(directory, 'list_vouchers', {}, 'tok-1'),
    ).rejects.toThrow('Unknown tool: list_vouchers');
    await expect(
      svc.callTool(directory, 'drop_tables', {}, 'tok-1'),
    ).rejects.toThrow('Unknown tool: drop_tables');
    expect(vouchers.findAll).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'MCP_TOOL',
        entity_id: 'list_vouchers',
        action: 'DENIED',
      }),
    );
  });

  it('runs an allowed tool through the controller with the caller as the user, and audits it', async () => {
    const students = {
      findOne: jest
        .fn()
        .mockResolvedValue({ data: { cc: 7570, full_name: 'A Student' } }),
    };
    const { svc, audit } = service({ [StudentsController.name]: students });
    const res = await svc.callTool(
      directory,
      'get_student',
      { cc: 7570 },
      'tok-1',
    );
    expect(students.findOne).toHaveBeenCalledWith(7570, directory);
    expect(res.isError).toBeUndefined();
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({
      cc: 7570,
      full_name: 'A Student',
    });
    const row = audit.log.mock.calls[0][0];
    expect(row).toMatchObject({
      entity_type: 'MCP_TOOL',
      entity_id: 'get_student',
      action: 'CALL',
      section: 'system',
    });
    expect(row.note).toBe('args {"cc":7570} · token tok-1');
  });

  it('reports a controller refusal as a tool error, not a crash', async () => {
    const students = {
      findOne: jest
        .fn()
        .mockRejectedValue(new NotFoundException('Student not found')),
    };
    const { svc, audit } = service({ [StudentsController.name]: students });
    const res = await svc.callTool(directory, 'get_student', { cc: 1 }, null);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe('Student not found');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ERROR' }),
    );
  });

  it('validates arguments the way the HTTP route does', async () => {
    const students = {
      findOne: jest.fn(),
      searchSimple: jest.fn().mockResolvedValue({ data: [] }),
    };
    const { svc } = service({ [StudentsController.name]: students });
    const bad = await svc.callTool(
      directory,
      'get_student',
      { cc: 'abc' },
      null,
    );
    expect(bad.isError).toBe(true);
    const extra = await svc.callTool(
      directory,
      'search_students',
      { q: 'ali', role: 'SUPER_ADMIN' },
      null,
    );
    expect(extra.isError).toBe(true);
    expect((extra.content[0] as { text: string }).text).toContain(
      'property role should not exist',
    );
    expect(students.findOne).not.toHaveBeenCalled();
    expect(students.searchSimple).not.toHaveBeenCalled();
  });

  it('whoami lists exactly the visible tools', async () => {
    const { svc } = service();
    const res = await svc.callTool(directory, 'whoami', {}, null);
    expect(
      JSON.parse((res.content[0] as { text: string }).text).tools.sort(),
    ).toEqual(names(svc, directory));
  });

  it('an access decision never throws for a forbidden route', () => {
    const { svc } = service();
    expect(() => svc.visibleTools(principal({}))).not.toThrow();
  });
});

describe('MCP result helpers', () => {
  it('caps long results and says so', () => {
    expect(capResult('abc', 10)).toEqual({ text: 'abc', truncated: false });
    const capped = capResult('x'.repeat(20), 10);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toContain('Result truncated at 10 of 20 characters');
  });

  it('summarises arguments without long text or nested data', () => {
    expect(
      summarizeArgs({
        cc: 1,
        q: 'a'.repeat(60),
        ids: [1, 2, 3, 4, 5, 6],
        nested: { a: 1 },
      }),
    ).toBe(`{"cc":1,"q":"${'a'.repeat(40)}…","ids":"[6 items]","nested":"…"}`);
  });
});
