import 'reflect-metadata';
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { McpTokensService } from './mcp-tokens.service';
import {
  generateMcpToken,
  hashMcpToken,
  MCP_TOKEN_MAX_LIVE,
} from './mcp-token.util';

const user = {
  id: 'user-1',
  username: 'finance.clerk',
  full_name: 'Finance Clerk',
  role: StaffRole.EMPLOYEE,
  campus_id: 2,
  allowed_class_ids: null,
};

function setup(
  opts: {
    row?: Record<string, unknown> | null;
    actions?: string[];
    live?: number;
  } = {},
) {
  const token = generateMcpToken();
  const row =
    opts.row === null
      ? null
      : {
          id: 'tok-1',
          user_id: user.id,
          token_hash: hashMcpToken(token),
          expires_at: new Date(Date.now() + 86_400_000),
          revoked_at: null,
          last_used_at: null,
          users: user,
          ...opts.row,
        };
  const prisma = {
    mcp_access_tokens: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(opts.live ?? 0),
      create: jest.fn(async ({ data }) => ({
        id: 'tok-new',
        name: data.name,
        token_prefix: data.token_prefix,
        created_at: new Date(),
        expires_at: data.expires_at,
        last_used_at: null,
        revoked_at: null,
      })),
    },
  };
  const strategy = {
    validate: jest.fn(async (p: IJwtStaffPayload) => ({
      ...p,
      permissions: [],
      actions: opts.actions ?? ['system.ai_assistant#view'],
      scope: {
        campuses: [2],
        segments: [],
        classes: [],
        sections: [],
        departments: [],
        staffCategories: [],
      },
    })),
  };
  const audit = { log: jest.fn().mockResolvedValue(1) };
  const svc = new McpTokensService(
    prisma as never,
    audit as never,
    strategy as never,
  );
  return { svc, token, prisma, strategy, audit };
}

describe('McpTokensService.authenticate (TAFSD-531)', () => {
  it('resolves a live token to the principal the JWT strategy builds for its owner', async () => {
    const { svc, token, strategy, prisma } = setup();
    const { user: principal, tokenId } = await svc.authenticate(token);
    expect(tokenId).toBe('tok-1');
    expect(prisma.mcp_access_tokens.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { token_hash: hashMcpToken(token) } }),
    );
    expect(strategy.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'user-1',
        username: 'finance.clerk',
        userType: 'STAFF',
        role: StaffRole.EMPLOYEE,
      }),
    );
    expect(principal.scope?.campuses).toEqual([2]);
  });

  it.each([
    ['revoked', { revoked_at: new Date() }],
    ['expired', { expires_at: new Date(Date.now() - 1000) }],
  ])(
    'refuses a %s token with the same 401 as an unknown one',
    async (_label, over) => {
      const { svc, token, strategy } = setup({ row: over });
      await expect(svc.authenticate(token)).rejects.toThrow(
        new UnauthorizedException('Invalid or expired MCP token'),
      );
      expect(strategy.validate).not.toHaveBeenCalled();
    },
  );

  it('refuses an unknown token and a missing one', async () => {
    const { svc, token } = setup({ row: null });
    await expect(svc.authenticate(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(svc.authenticate(null)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses a deactivated owner (the strategy throws)', async () => {
    const { svc, token, strategy } = setup();
    strategy.validate.mockRejectedValueOnce(
      new UnauthorizedException('Account is inactive'),
    );
    await expect(svc.authenticate(token)).rejects.toThrow(
      'Account is inactive',
    );
  });

  it('refuses an owner who no longer holds the AI Assistant tile', async () => {
    const { svc, token } = setup({ actions: ['student.directory#view'] });
    await expect(svc.authenticate(token)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lets a SUPER_ADMIN in without the tile', async () => {
    const { svc, token } = setup({
      row: { users: { ...user, role: StaffRole.SUPER_ADMIN } },
      actions: [],
    });
    await expect(svc.authenticate(token)).resolves.toMatchObject({
      tokenId: 'tok-1',
    });
  });

  it('records last use at most once a minute', async () => {
    const recent = setup({ row: { last_used_at: new Date() } });
    await recent.svc.authenticate(recent.token);
    expect(recent.prisma.mcp_access_tokens.update).not.toHaveBeenCalled();
    const stale = setup();
    await stale.svc.authenticate(stale.token);
    expect(stale.prisma.mcp_access_tokens.update).toHaveBeenCalledTimes(1);
  });
});

describe('McpTokensService.issue', () => {
  const caller = {
    sub: 'user-1',
    username: 'finance.clerk',
    fullName: 'Finance Clerk',
  } as IJwtStaffPayload;

  it('stores only the hash and returns the token once', async () => {
    const { svc, prisma, audit } = setup();
    const issued = await svc.issue(caller, { name: 'Claude Code' });
    const stored = prisma.mcp_access_tokens.create.mock.calls[0][0].data;
    expect(stored.token_hash).toBe(hashMcpToken(issued.token));
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(issued.token);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: 'MCP_TOKEN', action: 'CREATE' }),
    );
  });

  it('refuses while impersonating', async () => {
    const { svc } = setup();
    await expect(
      svc.issue({ ...caller, impersonatorId: 'admin-1' } as IJwtStaffPayload, {
        name: 'x',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('caps live tokens per person', async () => {
    const { svc } = setup({ live: MCP_TOKEN_MAX_LIVE });
    await expect(svc.issue(caller, { name: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
