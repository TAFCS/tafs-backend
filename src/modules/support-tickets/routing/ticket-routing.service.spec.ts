import { TicketStatus } from '@prisma/client';
import { TicketRoutingService } from './ticket-routing.service';

const staff = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  full_name: id.toUpperCase(),
  username: id,
  role: 'PRINCIPAL',
  is_active: true,
  deleted_at: null,
  ...over,
});

const queue = (id: number, name: string, members: ReturnType<typeof staff>[], over: Record<string, unknown> = {}) => ({
  id,
  name,
  category: 'GENERAL',
  assignment: 'POOL',
  allow_forward: false,
  is_fallback: false,
  is_active: true,
  members: members.map((user, i) => ({ queue_id: id, user_id: user.id, sort_order: i, user })),
  ...over,
});

const rule = (id: number, over: Record<string, unknown>) => ({
  id,
  name: `rule ${id}`,
  category: 'GENERAL',
  child_match: 'ANY',
  campus_id: null,
  segment_id: null,
  class_ids: [],
  subtopic: null,
  priority: 100,
  is_active: true,
  target_user: null,
  target_queue: null,
  ...over,
});

describe('TicketRoutingService.resolve', () => {
  const prisma = {
    ticket_routing_rules: { findMany: jest.fn() },
    ticket_queues: { findFirst: jest.fn() },
  };
  const scope = {
    resolve: jest.fn().mockResolvedValue({}),
    canSeeStudent: jest.fn().mockReturnValue(true),
  };
  const service = new TicketRoutingService(prisma as any, scope as any);
  const child = { category: 'GENERAL' as const, student: { campus_id: 1, class_id: 15, segment_id: 6 } };

  beforeEach(() => {
    jest.clearAllMocks();
    scope.canSeeStudent.mockReturnValue(true);
    prisma.ticket_queues.findFirst.mockResolvedValue(null);
  });

  it('assigns to the most specific rule target with no note', async () => {
    prisma.ticket_routing_rules.findMany.mockResolvedValue([
      rule(1, { campus_id: 1, target_user: staff('campus') }),
      rule(2, { campus_id: 1, class_ids: [15], target_user: staff('band') }),
    ]);

    const d = await service.resolve(child);

    expect(d).toMatchObject({ assigneeId: 'band', ruleId: 2, status: TicketStatus.ASSIGNED, note: null, routedRole: 'PRINCIPAL' });
  });

  it('skips an inactive target and records why', async () => {
    prisma.ticket_routing_rules.findMany.mockResolvedValue([
      rule(1, { campus_id: 1, class_ids: [15], target_user: staff('hira', { is_active: false }) }),
      rule(2, { campus_id: 1, target_user: staff('backup') }),
    ]);

    const d = await service.resolve(child);

    expect(d.assigneeId).toBe('backup');
    expect(d.ruleId).toBe(2);
    expect(d.note).toContain('HIRA is inactive');
  });

  it('skips a target whose scope cannot see the student', async () => {
    scope.canSeeStudent.mockImplementation((u: { role: string }) => u.role !== 'PRINCIPAL');
    prisma.ticket_routing_rules.findMany.mockResolvedValue([
      rule(1, { campus_id: 1, target_user: staff('narrow') }),
    ]);
    prisma.ticket_queues.findFirst.mockResolvedValue(
      queue(9, 'General desk', [staff('desk', { role: 'GENERAL_RESPONDENT' })], { assignment: 'AUTO', is_fallback: true }),
    );

    const d = await service.resolve(child);

    expect(d).toMatchObject({ assigneeId: 'desk', queueId: 9, ruleId: null, routedRole: 'GENERAL_RESPONDENT' });
    expect(d.note).toContain('outside their access scope');
  });

  it('pool queues leave the ticket open and unassigned', async () => {
    prisma.ticket_routing_rules.findMany.mockResolvedValue([
      rule(1, { category: 'FINANCIAL', target_queue: queue(4, 'Finance', [staff('clerk')], { category: 'FINANCIAL' }) }),
    ]);

    const d = await service.resolve({ category: 'FINANCIAL' });

    expect(d).toMatchObject({ assigneeId: null, status: TicketStatus.OPEN, queueId: 4, routedRole: 'FINANCE_CLERK' });
  });

  it('auto queues assign the first eligible member in order', async () => {
    prisma.ticket_routing_rules.findMany.mockResolvedValue([
      rule(1, {
        target_queue: queue(5, 'Desk', [staff('gone', { is_active: false }), staff('second'), staff('third')], { assignment: 'AUTO' }),
      }),
    ]);

    const d = await service.resolve({ category: 'GENERAL' });

    expect(d.assigneeId).toBe('second');
  });

  it('parks the ticket unassigned in the fallback when nobody can take it', async () => {
    prisma.ticket_routing_rules.findMany.mockResolvedValue([]);
    prisma.ticket_queues.findFirst.mockResolvedValue(
      queue(9, 'General desk', [staff('desk', { is_active: false })], { is_fallback: true }),
    );

    const d = await service.resolve(child);

    expect(d).toMatchObject({ assigneeId: null, status: TicketStatus.OPEN, queueId: 9 });
    expect(d.note).toContain('unassigned');
  });

  it('never throws when nothing is configured', async () => {
    prisma.ticket_routing_rules.findMany.mockResolvedValue([]);

    const d = await service.resolve(child);

    expect(d).toMatchObject({ assigneeId: null, status: TicketStatus.OPEN, queueId: null, ruleId: null });
  });
});
