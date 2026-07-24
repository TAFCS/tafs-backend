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
    broadcastTicketMessagesRead: jest.fn(),
    isParentInTicketRoom: jest.fn().mockReturnValue(false),
    isStaffInTicketRoom: jest.fn().mockResolvedValue(false),
  };

  const mockFcm = { sendToFamily: jest.fn(), sendToUsers: jest.fn() };
  const mockAuditLogs = { log: jest.fn() };

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
    users: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    guardians: {
      findFirst: jest.fn(),
    },
    $transaction: jest.fn((fn: (tx: typeof prisma) => unknown) => fn(prisma)),
  };

  let service: SupportTicketsService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGateway.isParentInTicketRoom.mockReturnValue(false);
    mockGateway.isStaffInTicketRoom.mockResolvedValue(false);
    service = new SupportTicketsService(
      prisma as any,
      mockFcm as any,
      mockGateway as any,
      mockAuditLogs as any,
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
      ticket: {
        id: 't1',
        family_id: 5,
        category: TicketCategory.GENERAL,
        subtopic: 'Fees',
        created_at: new Date('2026-01-01'),
        families: { household_name: 'Khan' },
      },
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
      category: TicketCategory.GENERAL,
      subtopic: 'Fees',
      created_at: new Date('2026-01-01'),
      families: { household_name: 'Khan' },
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
      message_type: 'TEXT',
      content: 'Rejected reply',
      status: MessageStatus.PENDING,
      ticket: {
        id: 't1',
        family_id: 5,
        category: TicketCategory.GENERAL,
        subtopic: 'Fees',
        created_at: new Date('2026-01-01'),
        families: { household_name: 'Khan' },
      },
    });
    prisma.ticket_messages.updateMany.mockResolvedValue({ count: 1 });
    prisma.ticket_messages.findUniqueOrThrow.mockResolvedValue({
      id: 'm1',
      status: MessageStatus.REJECTED,
    });
    prisma.support_tickets.findUniqueOrThrow.mockResolvedValue({
      id: 't1',
      created_at: new Date('2026-01-01'),
      category: TicketCategory.GENERAL,
      families: { household_name: 'Khan' },
    });
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
    prisma.support_tickets.findUniqueOrThrow.mockResolvedValue({
      id: 't1',
      category: TicketCategory.FINANCIAL,
      subtopic: 'Fees',
      created_at: new Date('2026-01-01'),
      families: { household_name: 'Khan' },
    });
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
      created_at: new Date('2026-01-01'),
      families: { household_name: 'Khan' },
    });
    prisma.support_tickets.update.mockResolvedValue({
      id: 't1',
      family_id: 5,
      subtopic: 'Academics',
      status: TicketStatus.CLOSED,
      category: TicketCategory.GENERAL,
      created_at: new Date('2026-01-01'),
      families: { household_name: 'Khan' },
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
      created_at: new Date('2026-01-01'),
      families: { household_name: 'Khan' },
    });
    prisma.support_tickets.update.mockResolvedValue({
      id: 't1',
      family_id: 5,
      subtopic: 'Academics',
      status: TicketStatus.CLOSED,
      category: TicketCategory.GENERAL,
      created_at: new Date('2026-01-01'),
      families: { household_name: 'Khan' },
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

  it('ticket created notifies superadmins and assignee', async () => {
    prisma.users.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]);

    await (service as any).notifyStaffTicketCreated({
      id: 't1',
      current_assignee_id: 'principal-1',
      routed_role: 'PRINCIPAL',
      subtopic: 'Academics',
      description: 'Need help with homework',
      students: { full_name: 'Ali Khan' },
      families: { household_name: 'Khan' },
    });

    expect(mockFcm.sendToUsers).toHaveBeenCalledWith(
      expect.arrayContaining(['admin-1', 'admin-2', 'principal-1']),
      'New support ticket',
      expect.stringContaining('Ali Khan'),
      expect.objectContaining({
        type: 'SUPPORT_TICKET_CREATED',
        ticketId: 't1',
      }),
    );
  });

  it('super admin reply auto-marks read when parent is already in ticket room', async () => {
    mockGateway.isParentInTicketRoom.mockReturnValue(true);

    prisma.support_tickets.findUnique.mockResolvedValue({
      id: 't1',
      family_id: 5,
      status: TicketStatus.ASSIGNED,
      current_assignee_id: 'staff-1',
      category: TicketCategory.GENERAL,
      subtopic: 'Fees',
    });
    prisma.ticket_messages.create.mockResolvedValue({
      id: 'm-live',
      message_type: 'TEXT',
      content: 'Seen live',
      status: MessageStatus.APPROVED,
      is_read: false,
      sender_user: { id: 'admin-1', full_name: 'Admin', role: 'SUPER_ADMIN' },
    });
    prisma.support_tickets.update.mockResolvedValue({});
    prisma.ticket_events.create.mockResolvedValue({});
    prisma.support_tickets.findUniqueOrThrow.mockResolvedValue({
      id: 't1',
      family_id: 5,
      current_assignee_id: 'staff-1',
    });
    prisma.ticket_messages.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.createStaffMessage(
      't1',
      { sub: 'admin-1', role: 'SUPER_ADMIN', userType: 'STAFF', username: 'admin' } as any,
      { messageType: 'TEXT', content: 'Seen live' },
    );

    expect(mockGateway.broadcastApprovedTicketMessage).toHaveBeenCalled();
    expect(mockFcm.sendToFamily).not.toHaveBeenCalled();
    expect(prisma.ticket_messages.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ticket_id: 't1',
          sender_type: 'STAFF',
          is_read: false,
        }),
        data: { is_read: true },
      }),
    );
    expect(prisma.support_tickets.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 't1' },
        data: expect.objectContaining({
          unread_by_parent: 0,
        }),
      }),
    );
    expect(mockGateway.broadcastTicketMessagesRead).toHaveBeenCalledWith(
      't1',
      5,
      'PARENT',
      'staff-1',
    );
    expect(result).toEqual(expect.objectContaining({ is_read: true }));
  });

  it('super admin reply still sends FCM when parent is not in ticket room', async () => {
    mockGateway.isParentInTicketRoom.mockReturnValue(false);

    prisma.support_tickets.findUnique.mockResolvedValue({
      id: 't1',
      family_id: 5,
      status: TicketStatus.ASSIGNED,
      current_assignee_id: 'staff-1',
      category: TicketCategory.GENERAL,
    });
    prisma.ticket_messages.create.mockResolvedValue({
      id: 'm-offline',
      message_type: 'TEXT',
      content: 'Offline parent',
      status: MessageStatus.APPROVED,
      is_read: false,
      sender_user: { id: 'admin-1', full_name: 'Admin', role: 'SUPER_ADMIN' },
    });
    prisma.support_tickets.update.mockResolvedValue({});
    prisma.ticket_events.create.mockResolvedValue({});
    prisma.support_tickets.findUniqueOrThrow.mockResolvedValue({
      id: 't1',
      family_id: 5,
      current_assignee_id: 'staff-1',
    });

    const result = await service.createStaffMessage(
      't1',
      { sub: 'admin-1', role: 'SUPER_ADMIN', userType: 'STAFF', username: 'admin' } as any,
      { messageType: 'TEXT', content: 'Offline parent' },
    );

    expect(mockFcm.sendToFamily).toHaveBeenCalled();
    expect(mockGateway.broadcastTicketMessagesRead).not.toHaveBeenCalled();
    expect(result.is_read).not.toBe(true);
  });

  it('parent message auto-marks read when staff is already in ticket room', async () => {
    mockGateway.isStaffInTicketRoom.mockResolvedValue(true);

    prisma.support_tickets.findUnique.mockResolvedValue({
      id: 't1',
      family_id: 5,
      student_id: 10,
      status: TicketStatus.ASSIGNED,
      current_assignee_id: 'staff-1',
      category: TicketCategory.GENERAL,
      subtopic: 'Fees',
      created_at: new Date('2026-01-01'),
      families: { household_name: 'Khan' },
    });
    prisma.guardians.findFirst.mockResolvedValue({
      id: 1,
      full_name: 'Parent',
    });

    const createdMessage = {
      id: 'm-parent',
      ticket_id: 't1',
      message_type: 'TEXT',
      content: 'Hello staff',
      status: MessageStatus.APPROVED,
      is_read: false,
      sender_guardian: { id: 1, full_name: 'Parent' },
    };
    const updatedTicket = {
      id: 't1',
      family_id: 5,
      category: TicketCategory.GENERAL,
      subtopic: 'Fees',
      created_at: new Date('2026-01-01'),
      families: { household_name: 'Khan' },
      students: null,
      current_assignee: null,
    };

    prisma.ticket_messages.create.mockResolvedValue(createdMessage);
    prisma.support_tickets.update.mockResolvedValue(updatedTicket);
    prisma.ticket_messages.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.createParentMessage(
      't1',
      { familyId: 5, userType: 'PARENT', sub: '5' } as any,
      { messageType: 'TEXT', content: 'Hello staff' },
    );

    expect(mockGateway.broadcastTicketMessageToStaff).toHaveBeenCalled();
    expect(prisma.ticket_messages.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ticket_id: 't1',
          sender_type: 'GUARDIAN',
          is_read: false,
        }),
        data: { is_read: true },
      }),
    );
    expect(prisma.support_tickets.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 't1' },
        data: expect.objectContaining({
          unread_by_staff: 0,
        }),
      }),
    );
    expect(mockGateway.broadcastTicketMessagesRead).toHaveBeenCalledWith(
      't1',
      5,
      'STAFF',
      'staff-1',
    );
    expect(result).toEqual(expect.objectContaining({ is_read: true }));
  });

  it('parent message does not auto-mark when staff is not in ticket room', async () => {
    mockGateway.isStaffInTicketRoom.mockResolvedValue(false);

    prisma.support_tickets.findUnique.mockResolvedValue({
      id: 't1',
      family_id: 5,
      student_id: 10,
      status: TicketStatus.ASSIGNED,
      current_assignee_id: 'staff-1',
      category: TicketCategory.GENERAL,
      subtopic: 'Fees',
      created_at: new Date('2026-01-01'),
      families: { household_name: 'Khan' },
    });
    prisma.guardians.findFirst.mockResolvedValue({
      id: 1,
      full_name: 'Parent',
    });

    const createdMessage = {
      id: 'm-parent-2',
      ticket_id: 't1',
      message_type: 'TEXT',
      content: 'Hello staff',
      status: MessageStatus.APPROVED,
      is_read: false,
      sender_guardian: { id: 1, full_name: 'Parent' },
    };
    const updatedTicket = {
      id: 't1',
      family_id: 5,
      category: TicketCategory.GENERAL,
      subtopic: 'Fees',
      created_at: new Date('2026-01-01'),
      families: { household_name: 'Khan' },
      students: null,
      current_assignee: null,
    };

    prisma.ticket_messages.create.mockResolvedValue(createdMessage);
    prisma.support_tickets.update.mockResolvedValue(updatedTicket);

    const result = await service.createParentMessage(
      't1',
      { familyId: 5, userType: 'PARENT', sub: '5' } as any,
      { messageType: 'TEXT', content: 'Hello staff' },
    );

    expect(mockGateway.broadcastTicketMessagesRead).not.toHaveBeenCalled();
    expect(result.is_read).not.toBe(true);
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
