import { ChatGateway } from './chat.gateway';

// TAFSD-235: live ticket-pool events follow queue membership, not role names.

function build(memberships: { queue_id: number }[] = []) {
  const emitted: { rooms: string[]; event: string }[] = [];
  const joins: string[] = [];
  const left: string[] = [];
  const server = {
    to: (r: string | string[]) => ({ emit: (event: string) => emitted.push({ rooms: [r].flat(), event }) }),
    in: (r: string | string[]) => ({
      socketsLeave: (room: string) => left.push(`${[r].flat().join(',')}:${room}`),
      socketsJoin: (room: string) => joins.push(`${[r].flat().join(',')}:${room}`),
    }),
  };
  const prisma = { ticket_queue_members: { findMany: jest.fn(async () => memberships) } };
  const gw = new ChatGateway({} as any, {} as any, prisma as any, {} as any, {} as any, {} as any);
  (gw as any).server = server;
  return { gw, emitted, joins, left, prisma };
}

const roomsFor = (emitted: { rooms: string[]; event: string }[], event: string) =>
  emitted.filter((e) => e.event === event).flatMap((e) => e.rooms);

describe('ChatGateway queue rooms', () => {
  it('a queued ticket goes to its queue room, not the finance role room', async () => {
    const { gw, emitted } = build();
    await gw.broadcastTicketCreated({ id: 't1', routed_queue_id: 4, routed_role: 'FINANCE_CLERK' });
    expect(roomsFor(emitted, 'ticketCreated')).toEqual(expect.arrayContaining(['ticket_queue_4']));
    expect(roomsFor(emitted, 'ticketCreated')).not.toContain('finance_queue');
  });

  it('a ticket routed before queues existed still reaches the old role room', async () => {
    const { gw, emitted } = build();
    await gw.broadcastTicketCreated({ id: 't2', routed_queue_id: null, routed_role: 'GENERAL_RESPONDENT' });
    expect(roomsFor(emitted, 'ticketCreated')).toContain('general_respondent_inbox');
  });

  it('claim, transfer and unclaimed messages go to the pool', async () => {
    const { gw, emitted } = build();
    const t = { id: 't3', routed_queue_id: 2, current_assignee_id: null, family_id: 1 };
    await gw.broadcastTicketClaimed(t);
    await gw.broadcastTicketTransferred(t, 'a', 'b');
    await gw.broadcastTicketMessageToStaff(t, { id: 'm' });
    for (const ev of ['ticketClaimed', 'ticketTransferred', 'ticketMessageReceived']) {
      expect(roomsFor(emitted, ev)).toContain('ticket_queue_2');
    }
  });

  it('messages on a claimed ticket stay with the assignee', async () => {
    const { gw, emitted } = build();
    await gw.broadcastTicketMessageToStaff({ id: 't4', routed_queue_id: 2, current_assignee_id: 'u9' }, { id: 'm' });
    expect(roomsFor(emitted, 'ticketMessageReceived')).not.toContain('ticket_queue_2');
    expect(roomsFor(emitted, 'ticketMessageReceived')).toContain('staff_inbox_u9');
  });

  it('syncQueueRoom empties the room, then joins the current members', async () => {
    const { gw, joins, left } = build();
    await gw.syncQueueRoom(5, ['u1', 'u2']);
    expect(left).toEqual(['ticket_queue_5:ticket_queue_5']);
    expect(joins).toEqual(['staff_inbox_u1,staff_inbox_u2:ticket_queue_5']);
  });
});
