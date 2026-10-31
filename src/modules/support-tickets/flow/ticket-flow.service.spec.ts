import { ConflictException, ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { TicketFlowStatus } from '@prisma/client';
import { TicketFlowService } from './ticket-flow.service';
import { defaultTree } from './flow-tree';

// TAFSD-447: drafts, publishing and version checks of the ticket flow.

const admin = { sub: 'u1', username: 'aawaiz.ali', role: 'SUPER_ADMIN' } as any;
const row = (version: number, status: TicketFlowStatus, extra: Record<string, unknown> = {}) => ({
  id: version,
  version,
  status,
  tree: defaultTree(),
  notes: null,
  lock_version: 0,
  created_from: null,
  created_at: new Date(),
  created_by: 'system',
  updated_at: new Date(),
  updated_by: 'system',
  published_at: new Date(),
  published_by: 'system',
  archived_at: null,
  ...extra,
});

function setup() {
  const tx = {
    ticket_flows: { updateMany: jest.fn(), update: jest.fn(), create: jest.fn(), delete: jest.fn(), aggregate: jest.fn(), count: jest.fn() },
    ticket_lanes: { upsert: jest.fn(), updateMany: jest.fn() },
  };
  const prisma: any = {
    ticket_flows: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    ticket_lanes: { findUnique: jest.fn(async ({ where }: any) => ({ id: where.key === 'fees' ? 2 : 1 })) },
    ticket_queues: { findMany: jest.fn(async () => []) },
    students: {
      findMany: jest.fn(async () => [
        { cc: 77, full_name: 'Ali', campus_id: 1, class_id: 15, photograph_url: null, classes: { description: 'VII', segment_id: 3 }, sections: null },
      ]),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const audit = { log: jest.fn() };
  const service = new TicketFlowService(prisma, {} as any, audit as any);
  return { service, prisma, tx, audit };
}

describe('TicketFlowService', () => {
  it('seeds version 1 the first time the flow is read, and syncs both lanes', async () => {
    const { service, prisma, tx } = setup();
    prisma.ticket_flows.findFirst.mockResolvedValue(null);
    tx.ticket_flows.count.mockResolvedValue(0);
    tx.ticket_flows.create.mockImplementation(async ({ data }: any) => ({ ...row(1, TicketFlowStatus.PUBLISHED), ...data }));
    const flow = await service.parentFlow(9);
    expect(flow.version).toBe(1);
    expect(flow.lanes.map((l) => l.key)).toEqual(['general', 'fees']);
    expect(flow.children[0]).toMatchObject({ student_id: 77, class_name: 'VII', segment_id: 3 });
    expect(tx.ticket_lanes.upsert).toHaveBeenCalledTimes(2);
  });

  it('resolves a v1 path to the old category and subtopic', async () => {
    const { service, prisma } = setup();
    prisma.ticket_flows.findFirst.mockResolvedValue(row(1, TicketFlowStatus.PUBLISHED));
    const o = await service.resolvePath(9, 1, ['fees', 'fees-child', 'f-refund-request'], null);
    expect(o).toMatchObject({
      category: 'FINANCIAL',
      subtopic: 'Refund Request',
      lane_id: 2,
      flow_version: 1,
      leaf_node_key: 'f-refund-request',
      path_keys: ['fees', 'fees-child', 'f-refund-request'],
      min_length: 20,
    });
  });

  it('accepts a just-replaced version for a day, then asks the parent to choose again', async () => {
    const { service, prisma } = setup();
    prisma.ticket_flows.findFirst.mockResolvedValue(row(3, TicketFlowStatus.PUBLISHED));
    prisma.ticket_flows.findUnique.mockResolvedValueOnce(row(2, TicketFlowStatus.ARCHIVED, { archived_at: new Date(Date.now() - 3600_000) }));
    await expect(service.resolvePath(9, 2, ['general', 'general-child', 'gn-transport'], null)).resolves.toMatchObject({ flow_version: 2 });
    prisma.ticket_flows.findUnique.mockResolvedValueOnce(row(1, TicketFlowStatus.ARCHIVED, { archived_at: new Date(Date.now() - 48 * 3600_000) }));
    await expect(service.resolvePath(9, 1, ['general', 'general-child', 'gn-transport'], null)).rejects.toBeInstanceOf(ConflictException);
  });

  it('turns a removed option into FLOW_CHANGED so the app reloads', async () => {
    const { service, prisma } = setup();
    prisma.ticket_flows.findFirst.mockResolvedValue(row(1, TicketFlowStatus.PUBLISHED));
    await expect(service.resolvePath(9, 1, ['general', 'gone'], null)).rejects.toMatchObject({
      response: { code: 'FLOW_CHANGED' },
    });
  });

  it('maps an old-app ticket to its lane and leaf, and never fails', async () => {
    const { service, prisma } = setup();
    prisma.ticket_flows.findFirst.mockResolvedValue(row(1, TicketFlowStatus.PUBLISHED));
    await expect(service.legacyOrigin('GENERAL', 'Other', true)).resolves.toMatchObject({ lane_id: 1, leaf_node_key: 'gc-other' });
    await expect(service.legacyOrigin('GENERAL', 'Something new', false)).resolves.toMatchObject({ lane_id: 1, leaf_node_key: null, path_keys: [] });
    prisma.ticket_flows.findFirst.mockRejectedValue(new Error('db down'));
    (service as any).cache = null;
    await expect(service.legacyOrigin('FINANCIAL', 'Refund Request', false)).resolves.toMatchObject({ lane_id: null, subtopic: 'Refund Request' });
  });

  it('refuses a stale draft save', async () => {
    const { service, prisma } = setup();
    prisma.ticket_flows.findFirst.mockResolvedValue(row(2, TicketFlowStatus.DRAFT, { lock_version: 4, updated_by: 'umer' }));
    prisma.ticket_flows.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.saveDraft(admin, defaultTree(), 3)).rejects.toThrow(/umer changed this draft/);
  });

  it('will not publish a draft with errors, and archives the old version when it does', async () => {
    const { service, prisma, tx, audit } = setup();
    const broken = defaultTree();
    broken.lanes[0].children = [];
    prisma.ticket_flows.findFirst.mockImplementation(async ({ where }: any) =>
      where.status === TicketFlowStatus.DRAFT ? row(2, TicketFlowStatus.DRAFT, { tree: broken }) : row(1, TicketFlowStatus.PUBLISHED),
    );
    await expect(service.publish(admin, 'x', 0)).rejects.toBeInstanceOf(UnprocessableEntityException);

    const next = defaultTree();
    next.lanes[0].label = 'School matters';
    prisma.ticket_flows.findFirst.mockImplementation(async ({ where }: any) =>
      where.status === TicketFlowStatus.DRAFT ? row(2, TicketFlowStatus.DRAFT, { tree: next }) : row(1, TicketFlowStatus.PUBLISHED),
    );
    const res = await service.publish(admin, 'Renamed General', 0);
    expect(res.diff.renamed).toEqual(['General → School matters']);
    expect(tx.ticket_flows.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: TicketFlowStatus.ARCHIVED }) }),
    );
    expect(tx.ticket_lanes.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ name: 'School matters' }) }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'PUBLISHED', entity_type: 'SUPPORT_TICKET_FLOW' }));
  });

  it('is super admin only', async () => {
    const { service } = setup();
    await expect(service.overview({ ...admin, role: 'CAMPUS_ADMIN' })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
