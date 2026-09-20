import 'reflect-metadata';

jest.mock('@react-pdf/renderer', () => ({ renderToBuffer: jest.fn() }));
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { StaffRole, TicketCategory, TicketStatus } from '@prisma/client';
import { SupportTicketsController } from '../support-tickets/support-tickets.controller';
import { SupportTicketsService } from '../support-tickets/support-tickets.service';
import { AppConfigController } from '../app-config/app-config.controller';
import { TILES_MANIFEST, actionKey } from './tiles.manifest';
import { computeEffectiveAccess, type EffectiveTile } from './access.effective';
import {
  REQUIRE_ACTION_KEY,
  type RequireActionMetadata,
} from '../../decorators/require-action.decorator';

const tile = (id: string) => TILES_MANIFEST.find((t) => t.id === id)!;

const effectiveTiles: EffectiveTile[] = TILES_MANIFEST.map((t) => ({
  id: t.id,
  capabilities: t.capabilities,
  actions: t.actions?.map((a) => ({ id: a.id, default: !!a.default, implies: a.implies ?? [] })),
  legacyFullAccessCapabilities: t.legacyFullAccessCapabilities,
}));
const base = {
  allPermissionKeys: [...new Set(TILES_MANIFEST.flatMap((t) => t.capabilities))],
  activeTiles: effectiveTiles,
  packTileIds: [] as string[],
  allowTileIds: [] as string[],
  denyTileIds: [] as string[],
  userPerms: [] as { key: string; granted: boolean }[],
};

function meta(target: object, handler?: string): RequireActionMetadata | undefined {
  return Reflect.getMetadata(REQUIRE_ACTION_KEY, handler ? (target as any)[handler] : (target as any));
}

function keysExist(keys: string[]) {
  for (const key of keys) {
    const [tileId, actionId] = key.split('#');
    expect({ key, ok: !!tile(tileId)?.actions?.some((a) => a.id === actionId) }).toEqual({ key, ok: true });
  }
}

const scopedUser = {
  sub: 'u-1',
  role: 'FINANCE_CLERK',
  campusId: null,
  allowedClassIds: [],
  userType: 'STAFF',
} as any;

describe('Support Tickets', () => {
  const t = tile('communication.support_tickets');

  it('is bridged from communication.support_tickets.approve, so a view-only role gets view and an approver gets all actions', () => {
    expect(t.legacyFullAccessCapabilities).toEqual(['communication.support_tickets.approve']);
    const viewOnly = computeEffectiveAccess({
      ...base,
      role: StaffRole.GENERAL_RESPONDENT,
      roleKeys: ['communication.support_tickets.view'],
    });
    const held = viewOnly.actionIds.filter((k) => k.startsWith('communication.support_tickets#'));
    expect(held).toEqual([actionKey('communication.support_tickets', 'view')]);

    const fullAccess = computeEffectiveAccess({
      ...base,
      role: StaffRole.SUPER_ADMIN,
      roleKeys: ['communication.support_tickets.view', 'communication.support_tickets.approve'],
    });
    for (const a of t.actions!) {
      expect(fullAccess.actionIds).toContain(actionKey('communication.support_tickets', a.id));
    }
  });

  it('decorates routes with tile actions', () => {
    const proto = SupportTicketsController.prototype;
    expect(meta(proto, 'myQueue')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'view'),
    ]);
    expect(meta(proto, 'financeQueue')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'view'),
    ]);
    expect(meta(proto, 'oversightQueue')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'view'),
    ]);
    expect(meta(proto, 'closedTickets')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'view'),
    ]);
    expect(meta(proto, 'getTicket')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'view'),
    ]);
    expect(meta(proto, 'markRead')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'view'),
    ]);

    expect(meta(proto, 'pendingApprovals')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'manage_replies'),
    ]);
    expect(meta(proto, 'editMessage')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'manage_replies'),
    ]);
    expect(meta(proto, 'reviewMessage')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'manage_replies'),
    ]);
    expect(meta(proto, 'deleteMessage')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'manage_replies'),
    ]);

    expect(meta(proto, 'claimTicket')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'reassign'),
    ]);
    expect(meta(proto, 'transferTicket')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'reassign'),
    ]);
    expect(meta(proto, 'forwardTicket')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'reassign'),
    ]);

    expect(meta(proto, 'createMessage')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'respond'),
    ]);
    expect(meta(proto, 'closeTicket')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'respond'),
    ]);
    expect(meta(proto, 'uploadMedia')?.actionKeys).toEqual([
      actionKey('communication.support_tickets', 'respond'),
    ]);

    keysExist([
      'communication.support_tickets#view',
      'communication.support_tickets#respond',
      'communication.support_tickets#reassign',
      'communication.support_tickets#manage_replies',
    ]);
  });

  function svc(opts: { ticket?: unknown; canSee?: boolean }) {
    const prisma = {
      support_tickets: {
        findUnique: jest.fn().mockResolvedValue(opts.ticket ?? null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({}),
      },
      ticket_messages: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      ticket_events: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      audit_logs: { log: jest.fn() },
    };
    const scope = {
      isExempt: jest.fn().mockReturnValue(false),
      canSeeStudent: jest.fn().mockReturnValue(opts.canSee ?? true),
      whereForStudents: jest.fn().mockReturnValue({ campus_id: { in: [3] } }),
    };
    const fcmService = { sendPush: jest.fn() };
    const chatGateway = { broadcastApprovedTicketMessage: jest.fn() };
    const auditLogs = { log: jest.fn() };
    const s = new SupportTicketsService(
      prisma as any,
      fcmService as any,
      chatGateway as any,
      auditLogs as any,
      scope as any,
    );
    return { s, prisma, scope };
  }

  it('narrows financeQueue, oversightQueue, and closedTickets to caller student scope', async () => {
    const { s, prisma } = svc({});
    await s.listFinanceQueue(scopedUser);
    const financeWhere = prisma.support_tickets.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(financeWhere.OR)).toContain('"campus_id":{"in":[3]}');

    await s.listOversightQueue({ ...scopedUser, role: 'SUPER_ADMIN' });
    const oversightWhere = prisma.support_tickets.findMany.mock.calls[1][0].where;
    expect(JSON.stringify(oversightWhere.OR)).toContain('"campus_id":{"in":[3]}');

    await s.listClosedTickets(scopedUser);
    const closedWhere = prisma.support_tickets.findMany.mock.calls[2][0].where;
    expect(JSON.stringify(closedWhere.OR)).toContain('"campus_id":{"in":[3]}');
  });

  it('404s an out-of-scope ticket on getTicketById', async () => {
    const outOfScopeTicket = {
      id: 't-1',
      family_id: 1,
      status: TicketStatus.OPEN,
      category: TicketCategory.FINANCIAL,
      routed_role: StaffRole.FINANCE_CLERK,
      current_assignee_id: 'u-1',
      students: { cc: 1, campus_id: 1, class_id: 3, section_id: 4, classes: { segment_id: 1 } },
    };
    const { s } = svc({ ticket: outOfScopeTicket, canSee: false });
    await expect(s.getTicketById('t-1', scopedUser)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('Notification Templates', () => {
  const t = tile('communication.notification_templates');

  it('is bridged from system.permissions.manage, so a role with manage perms gets all actions', () => {
    expect(t.legacyFullAccessCapabilities).toEqual(['system.permissions.manage']);
    const fullAccess = computeEffectiveAccess({
      ...base,
      role: StaffRole.SUPER_ADMIN,
      roleKeys: ['communication.send_announcements', 'system.permissions.manage'],
    });
    for (const a of t.actions!) {
      expect(fullAccess.actionIds).toContain(actionKey('communication.notification_templates', a.id));
    }
  });

  it('decorates routes with tile actions', () => {
    const proto = AppConfigController.prototype;
    expect(meta(proto, 'getAllConfigs')?.actionKeys).toEqual([
      actionKey('communication.notification_templates', 'view'),
      'system.developer_settings#view',
    ]);
    expect(meta(proto, 'setConfig')?.actionKeys).toEqual([
      actionKey('communication.notification_templates', 'edit'),
      'system.developer_settings#edit',
    ]);

    keysExist([
      'communication.notification_templates#view',
      'communication.notification_templates#edit',
    ]);
  });
});
