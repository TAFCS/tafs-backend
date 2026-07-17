import { ForbiddenException } from '@nestjs/common';
import { MessageStatus, TicketCategory, TicketStatus } from '@prisma/client';
import { SupportTicketsService } from './support-tickets.service';
import { pickPrincipal } from '../../common/support-ticket-routing';

describe('SupportTicketsService leak-proofing', () => {
  const mockGateway = {
    broadcastTicketCreated: jest.fn(),
    broadcastTicketClaimed: jest.fn(),
    broadcastReplyPendingApproval: jest.fn(),
    broadcastApprovedTicketMessage: jest.fn(),
    broadcastReplyRejected: jest.fn(),
    broadcastTicketMessageToStaff: jest.fn(),
    broadcastTicketClosed: jest.fn(),
    isParentInTicketRoom: jest.fn().mockReturnValue(false),
  };

  const mockFcm = { sendToFamily: jest.fn() };

  const prisma = {
    support_tickets: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    ticket_messages: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    ticket_events: { create: jest.fn() },
    $transaction: jest.fn((fn: (tx: typeof prisma) => unknown) => fn(prisma)),
  };

  let service: SupportTicketsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SupportTicketsService(
      prisma as any,
      mockFcm as any,
      mockGateway as any,
    );
  });

  it('parent message filter excludes pending staff replies', () => {
    const where = (service as any).messageVisibilityWhere(
      { userType: 'PARENT', familyId: 1 },
      { id: 't1' },
    );
    expect(where.OR).toEqual([
      { sender_type: 'GUARDIAN' },
      { sender_type: 'STAFF', status: MessageStatus.APPROVED },
    ]);
  });

  it('parent event filter hides internal workflow events', () => {
    const where = (service as any).eventVisibilityWhere({
      userType: 'PARENT',
      familyId: 1,
    });
    expect(where.event_type.in).toEqual([
      'CREATED',
      'CLOSED_BY_STAFF',
      'CLOSED_BY_PARENT',
    ]);
  });

  it('staff event filter returns all events', () => {
    const where = (service as any).eventVisibilityWhere({
      userType: 'STAFF',
      sub: 'staff-1',
      role: 'PRINCIPAL',
    });
    expect(where).toEqual({});
  });

  it('staff reply is created as PENDING without parent side effects', async () => {
    prisma.support_tickets.findUnique.mockResolvedValue({
      id: 't1',
      status: TicketStatus.ASSIGNED,
      current_assignee_id: 'staff-1',
      category: TicketCategory.GENERAL,
    });
    prisma.ticket_messages.create.mockResolvedValue({
      id: 'm1',
      status: MessageStatus.PENDING,
    });

    await service.createStaffMessage(
      't1',
      { sub: 'staff-1', role: 'PRINCIPAL', userType: 'STAFF' } as any,
      { messageType: 'TEXT', content: 'Hello parent' },
    );

    expect(prisma.ticket_messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: MessageStatus.PENDING }),
      }),
    );
    expect(mockGateway.broadcastReplyPendingApproval).toHaveBeenCalled();
    expect(mockFcm.sendToFamily).not.toHaveBeenCalled();
  });

  it('super admin reply is auto-approved and delivered to parent', async () => {
    prisma.support_tickets.findUnique.mockResolvedValue({
      id: 't1',
      family_id: 5,
      status: TicketStatus.ASSIGNED,
      current_assignee_id: 'staff-1',
      category: TicketCategory.GENERAL,
    });
    prisma.ticket_messages.create.mockResolvedValue({
      id: 'm-admin',
      message_type: 'TEXT',
      content: 'Direct admin reply',
      status: MessageStatus.APPROVED,
    });
    prisma.support_tickets.update.mockResolvedValue({});
    prisma.ticket_events.create.mockResolvedValue({});
    prisma.support_tickets.findUniqueOrThrow.mockResolvedValue({
      id: 't1',
      family_id: 5,
    });

    await service.createStaffMessage(
      't1',
      { sub: 'admin-1', role: 'SUPER_ADMIN', userType: 'STAFF' } as any,
      { messageType: 'TEXT', content: 'Direct admin reply' },
    );

    expect(prisma.ticket_messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MessageStatus.APPROVED,
          reviewed_by: 'admin-1',
        }),
      }),
    );
    expect(prisma.support_tickets.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          unread_by_parent: { increment: 1 },
        }),
      }),
    );
    expect(mockGateway.broadcastApprovedTicketMessage).toHaveBeenCalled();
    expect(mockGateway.broadcastReplyPendingApproval).not.toHaveBeenCalled();
    expect(mockFcm.sendToFamily).toHaveBeenCalledWith(
      5,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        type: 'SUPPORT_TICKET_MESSAGE',
        ticketId: 't1',
        messageId: 'm-admin',
      }),
    );
  });

  it('non-assignee staff cannot post to ticket', async () => {
    prisma.support_tickets.findUnique.mockResolvedValue({
      id: 't1',
      status: TicketStatus.ASSIGNED,
      current_assignee_id: 'staff-2',
      category: TicketCategory.GENERAL,
    });

    await expect(
      service.createStaffMessage(
        't1',
        { sub: 'staff-1', role: 'PRINCIPAL', userType: 'STAFF' } as any,
        { messageType: 'TEXT', content: 'Hello parent' },
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('approve flow delivers to parent and triggers FCM when parent offline', async () => {
    const pendingMessage = {
      id: 'm1',
      ticket_id: 't1',
      sender_user_id: 'staff-1',
      message_type: 'TEXT',
      content: 'Approved reply',
      status: MessageStatus.PENDING,
    };
    prisma.ticket_messages.findUnique.mockResolvedValue({
      ...pendingMessage,
      ticket: { id: 't1', family_id: 5 },
    });
    prisma.ticket_messages.updateMany.mockResolvedValue({ count: 1 });
    prisma.ticket_messages.findUniqueOrThrow.mockResolvedValue({
      ...pendingMessage,
      status: MessageStatus.APPROVED,
    });
    prisma.support_tickets.findUniqueOrThrow.mockResolvedValue({
      id: 't1',
      family_id: 5,
      current_assignee_id: 'staff-1',
    });
    prisma.ticket_events.create.mockResolvedValue({});

    await service.reviewReply(
      'm1',
      { status: MessageStatus.APPROVED },
      { sub: 'admin-1', role: 'SUPER_ADMIN', userType: 'STAFF' } as any,
    );

    expect(mockGateway.broadcastApprovedTicketMessage).toHaveBeenCalled();
    expect(mockFcm.sendToFamily).toHaveBeenCalledWith(
      5,
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        type: 'SUPPORT_TICKET_MESSAGE',
        ticketId: 't1',
        messageId: 'm1',
      }),
    );
  });

  it('reject flow requires a rejection reason', async () => {
    prisma.ticket_messages.findUnique.mockResolvedValue({
      id: 'm1',
      ticket_id: 't1',
      sender_user_id: 'staff-1',
      status: MessageStatus.PENDING,
      ticket: { id: 't1' },
    });

    await expect(
      service.reviewReply(
        'm1',
        { status: MessageStatus.REJECTED },
        { sub: 'admin-1', role: 'SUPER_ADMIN', userType: 'STAFF' } as any,
      ),
    ).rejects.toThrow('Rejection reason is required');
  });

  it('reject flow does not notify parent', async () => {
    prisma.ticket_messages.findUnique.mockResolvedValue({
      id: 'm1',
      ticket_id: 't1',
      sender_user_id: 'staff-1',
      status: MessageStatus.PENDING,
      ticket: { id: 't1' },
    });
    prisma.ticket_messages.updateMany.mockResolvedValue({ count: 1 });
    prisma.ticket_messages.findUniqueOrThrow.mockResolvedValue({
      id: 'm1',
      status: MessageStatus.REJECTED,
    });
    prisma.support_tickets.findUniqueOrThrow.mockResolvedValue({ id: 't1' });
    prisma.ticket_events.create.mockResolvedValue({});

    await service.reviewReply(
      'm1',
      { status: MessageStatus.REJECTED, comment: 'Try again' },
      { sub: 'admin-1', role: 'SUPER_ADMIN', userType: 'STAFF' } as any,
    );

    expect(mockGateway.broadcastReplyRejected).toHaveBeenCalled();
    expect(mockFcm.sendToFamily).not.toHaveBeenCalled();
  });

  it('approve flow throws ConflictException when message already reviewed', async () => {
    prisma.ticket_messages.findUnique.mockResolvedValue({
      id: 'm1',
      ticket_id: 't1',
      sender_user_id: 'staff-1',
      status: MessageStatus.PENDING,
      ticket: { id: 't1', family_id: 5 },
    });
    prisma.ticket_messages.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.reviewReply(
        'm1',
        { status: MessageStatus.APPROVED },
        { sub: 'admin-1', role: 'SUPER_ADMIN', userType: 'STAFF' } as any,
      ),
    ).rejects.toThrow('Reply has already been reviewed');
  });

  it('finance claim uses atomic updateMany', async () => {
    prisma.support_tickets.updateMany.mockResolvedValue({ count: 1 });
    prisma.support_tickets.findUniqueOrThrow.mockResolvedValue({ id: 't1' });
    prisma.ticket_events.create.mockResolvedValue({});

    await service.claimTicket('t1', {
      sub: 'clerk-1',
      role: 'FINANCE_CLERK',
      userType: 'STAFF',
    } as any);

    expect(prisma.support_tickets.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ current_assignee_id: null }),
      }),
    );
  });

  it('staff close notifies parent via FCM when parent is offline', async () => {
    prisma.support_tickets.findUnique.mockResolvedValue({
      id: 't1',
      status: TicketStatus.ASSIGNED,
      current_assignee_id: 'staff-1',
      category: TicketCategory.GENERAL,
      family_id: 5,
      subtopic: 'Academics',
    });
    prisma.support_tickets.update.mockResolvedValue({
      id: 't1',
      family_id: 5,
      subtopic: 'Academics',
      status: TicketStatus.CLOSED,
    });
    prisma.ticket_events.create.mockResolvedValue({});
    mockGateway.isParentInTicketRoom.mockReturnValue(false);

    await service.closeByStaff(
      't1',
      { sub: 'staff-1', role: 'PRINCIPAL', userType: 'STAFF' } as any,
      { note: 'Resolved' },
    );

    expect(mockGateway.broadcastTicketClosed).toHaveBeenCalled();
    expect(mockFcm.sendToFamily).toHaveBeenCalledWith(
      5,
      'Query closed',
      'Resolved',
      expect.objectContaining({
        type: 'SUPPORT_TICKET_CLOSED',
        ticketId: 't1',
      }),
    );
  });

  it('staff close skips FCM when parent is viewing the ticket', async () => {
    prisma.support_tickets.findUnique.mockResolvedValue({
      id: 't1',
      status: TicketStatus.ASSIGNED,
      current_assignee_id: 'staff-1',
      category: TicketCategory.GENERAL,
      family_id: 5,
      subtopic: 'Academics',
    });
    prisma.support_tickets.update.mockResolvedValue({
      id: 't1',
      family_id: 5,
      subtopic: 'Academics',
      status: TicketStatus.CLOSED,
    });
    prisma.ticket_events.create.mockResolvedValue({});
    mockGateway.isParentInTicketRoom.mockReturnValue(true);

    await service.closeByStaff(
      't1',
      { sub: 'staff-1', role: 'PRINCIPAL', userType: 'STAFF' } as any,
      {},
    );

    expect(mockGateway.broadcastTicketClosed).toHaveBeenCalled();
    expect(mockFcm.sendToFamily).not.toHaveBeenCalled();
  });
});

describe('pickPrincipal integration', () => {
  it('matches roster shape campus-wide over class-band', () => {
    const result = pickPrincipal([
      { id: 'hira', allowed_class_ids: [15, 16, 17, 18, 19] },
      { id: 'samia', allowed_class_ids: [] },
    ]);
    expect(result?.id).toBe('samia');
  });
});
