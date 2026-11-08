import { ForbiddenException } from '@nestjs/common';
import { MessageStatus, TicketCategory, TicketStatus } from '@prisma/client';
import { SupportTicketsService } from './support-tickets.service';

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
    broadcastTicketMessageDeleted: jest.fn(),
    isParentInTicketRoom: jest.fn().mockReturnValue(false),
    isStaffInTicketRoom: jest.fn().mockResolvedValue(false),
  };

  const mockFcm = { sendToFamily: jest.fn(), sendToUsers: jest.fn() };
  const mockAuditLogs = { log: jest.fn() };
  const mockScope = { isExempt: jest.fn().mockReturnValue(true), canSeeStudent: jest.fn() };
  const mockRouting = {
    resolve: jest.fn(),
    queueIdsFor: jest.fn().mockResolvedValue([]),
    activeMembers: jest.fn().mockResolvedValue([]),
  };

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
    students: { findFirst: jest.fn() },
    classes: { findUnique: jest.fn() },
    ticket_queues: { findUnique: jest.fn() },
    $transaction: jest.fn((fn: (tx: typeof prisma) => unknown) => fn(prisma)),
  };

  let service: SupportTicketsService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGateway.isParentInTicketRoom.mockReturnValue(false);
    mockGateway.isStaffInTicketRoom.mockResolvedValue(false);
    mockScope.isExempt.mockReturnValue(true);
    mockRouting.queueIdsFor.mockResolvedValue([]);
    mockRouting.activeMembers.mockResolvedValue([]);
    service = new SupportTicketsService(
      prisma as any,
      mockFcm as any,
      mockGateway as any,
      mockAuditLogs as any,
      mockScope as any,
      mockRouting as any,
      {} as any,
    );
  });

  it('parent message filter excludes pending staff replies but keeps approved tombstones', () => {
    const where = (service as any).messageVisibilityWhere(
      { userType: 'PARENT', familyId: 1 },
      { id: 't1' },
    );
    expect(where).toEqual({
      OR: [
        { sender_type: 'GUARDIAN', deleted_at: null },
        { sender_type: 'STAFF', status: MessageStatus.APPROVED },
      ],
    });
  });

  it('staff message filter keeps approved tombstones and own non-deleted pending', () => {
    const where = (service as any).messageVisibilityWhere(
      { userType: 'STAFF', sub: 'staff-1', role: 'PRINCIPAL' },
      { id: 't1' },
    );
    expect(where).toEqual({
      OR: [
        { sender_type: 'GUARDIAN', deleted_at: null },
        { sender_type: 'STAFF', status: MessageStatus.APPROVED },
        {
          sender_type: 'STAFF',
          sender_user_id: 'staff-1',
          deleted_at: null,
        },
      ],
    });
  });

  it('super admin message filter includes deleted rows', () => {
    const where = (service as any).messageVisibilityWhere(
      { userType: 'STAFF', sub: 'admin-1', role: 'SUPER_ADMIN' },
      { id: 't1' },
    );
    expect(where).toEqual({});
  });

  it('presentTicketMessage strips content and media for deleted rows', () => {
    const presented = (service as any).presentTicketMessage({
      id: 'm1',
      content: 'secret body',
      deleted_at: new Date('2026-08-15'),
      media_metadata: { url: 'https://example.com/file.png' },
    });
    expect(presented).toEqual({
      id: 'm1',
      content: '',
      deleted_at: new Date('2026-08-15'),
      media_metadata: null,
      is_deleted: true,
    });
  });

  it('non-super-admin cannot delete ticket messages', async () => {
    await expect(
      service.deleteOwnStaffMessage('m1', {
        sub: 'staff-1',
        role: 'PRINCIPAL',
        userType: 'STAFF',
        username: 'principal',
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.ticket_messages.findUnique).not.toHaveBeenCalled();
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

  it('queue claim uses atomic updateMany limited to the caller\'s queues', async () => {
    mockRouting.queueIdsFor.mockResolvedValue([1]);
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
        where: expect.objectContaining({
          current_assignee_id: null,
          routed_queue_id: { in: [1] },
        }),
      }),
    );
  });

  it('refuses claims from staff outside every queue', async () => {
    await expect(
      service.claimTicket('t1', { sub: 'teacher', role: 'TEACHER', userType: 'STAFF' } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
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

  describe('resolveRouting', () => {
    const origin = {
      lane_id: null, flow_version: null, leaf_node_key: null, flow_path: null, path_keys: [],
      leaf_queue_id: null, lane_fallback_queue_id: null, min_length: 20,
    };
    const decision = { routedRole: 'PRINCIPAL', assigneeId: 'u', status: TicketStatus.ASSIGNED, queueId: null, ruleId: 3, note: null };

    it('hands the routing service the child placement including segment', async () => {
      prisma.students.findFirst.mockResolvedValue({ cc: 77, campus_id: 1, class_id: 15 });
      prisma.classes.findUnique.mockResolvedValue({ segment_id: 6 });
      mockRouting.resolve.mockResolvedValue(decision);

      const routing = await (service as any).resolveRouting(
        1,
        { ...origin, category: TicketCategory.GENERAL, subtopic: 'Academics / Classwork', path_keys: ['general', 'general-child', 'gc-academics-classwork'] },
        77,
      );

      expect(routing).toBe(decision);
      expect(mockRouting.resolve).toHaveBeenCalledWith({
        category: TicketCategory.GENERAL,
        subtopic: 'Academics / Classwork',
        student: { campus_id: 1, class_id: 15, segment_id: 6 },
        path_keys: ['general', 'general-child', 'gc-academics-classwork'],
        leaf_queue_id: null,
        lane_fallback_queue_id: null,
      });
    });

    it('routes family-level tickets without a student', async () => {
      mockRouting.resolve.mockResolvedValue(decision);
      await (service as any).resolveRouting(1, { ...origin, category: TicketCategory.GENERAL, subtopic: 'Transport', leaf_queue_id: 4 }, null);
      expect(mockRouting.resolve).toHaveBeenCalledWith({
        category: TicketCategory.GENERAL,
        subtopic: 'Transport',
        student: null,
        path_keys: [],
        leaf_queue_id: 4,
        lane_fallback_queue_id: null,
      });
    });
  });

  describe('moveTicket (TAFSD-448)', () => {
    const mockFlow = { originForLeaf: jest.fn(), moveTopics: jest.fn(), defaultLaneId: jest.fn() };
    const routing = {
      resolve: jest.fn(),
      queueIdsFor: jest.fn(),
      activeMembers: jest.fn().mockResolvedValue([]),
      deskOptions: jest.fn(),
    };
    const gateway = { ...mockGateway, broadcastTicketMoved: jest.fn() };
    let mover: SupportTicketsService;

    const academics = {
      id: 't1',
      family_id: 9,
      status: TicketStatus.ASSIGNED,
      category: TicketCategory.GENERAL,
      subtopic: 'Academics / Classwork',
      student_id: 77,
      students: { campus_id: 1, class_id: 15, section_id: 3, full_name: 'Ali', classes: { segment_id: 6 } },
      families: { household_name: 'Khan', students: [] },
      current_assignee_id: 'principal',
      current_assignee: { full_name: 'Principal P' },
      routed_queue_id: 2,
      routed_queue: { id: 2, name: 'General desk' },
      routed_role: 'GENERAL_RESPONDENT',
      lane_id: 1,
      lane: { name: 'General' },
      flow_version: 3,
      leaf_node_key: 'gc-academics-classwork',
      flow_path: [{ key: 'general', type: 'LANE', label: 'General' }],
      created_at: new Date('2026-11-01'),
    };
    const refundOrigin = {
      category: TicketCategory.FINANCIAL,
      subtopic: 'Refund Request',
      lane_id: 2,
      flow_version: 3,
      leaf_node_key: 'f-refund-request',
      flow_path: [{ key: 'fees', type: 'LANE', label: 'Fees & Payments' }],
      path_keys: ['fees', 'fees-child', 'f-refund-request'],
      leaf_queue_id: null,
      lane_fallback_queue_id: null,
      min_length: 20,
    };
    const principal = { sub: 'principal', username: 'p', role: 'PRINCIPAL', userType: 'STAFF' } as any;
    const admin = { sub: 'admin', username: 'sa', role: 'SUPER_ADMIN', userType: 'STAFF' } as any;
    const outsider = { sub: 'other', username: 'o', role: 'GENERAL_RESPONDENT', userType: 'STAFF' } as any;

    beforeEach(() => {
      routing.queueIdsFor.mockResolvedValue([2]);
      routing.activeMembers.mockResolvedValue([{ id: 'clerk' }]);
      prisma.support_tickets.findUnique.mockResolvedValue(academics);
      prisma.support_tickets.updateMany.mockResolvedValue({ count: 1 });
      prisma.support_tickets.findUniqueOrThrow.mockResolvedValue({ ...academics, current_assignee_id: null, routed_queue_id: 5 });
      (prisma.ticket_queues.findUnique as jest.Mock).mockResolvedValue({ name: 'Finance' });
      (prisma as any).users.findUnique = jest.fn().mockResolvedValue(null);
      mover = new SupportTicketsService(
        prisma as any,
        mockFcm as any,
        gateway as any,
        mockAuditLogs as any,
        mockScope as any,
        routing as any,
        mockFlow as any,
      );
    });

    it('moves a General / Academics ticket to Fees / Refund and lands it with Finance', async () => {
      mockFlow.originForLeaf.mockResolvedValue(refundOrigin);
      routing.resolve.mockResolvedValue({
        routedRole: 'FINANCE_CLERK', assigneeId: null, status: TicketStatus.OPEN, queueId: 5, ruleId: null, note: null,
      });
      routing.deskOptions.mockResolvedValue([{ id: 5, in_scope: true, members: [] }]);

      await mover.moveTicket('t1', { leafKey: 'f-refund-request', reason: 'This is about a refund' }, principal);

      expect(mockFlow.originForLeaf).toHaveBeenCalledWith(9, 'f-refund-request', { campus_id: 1, class_id: 15, segment_id: 6 });
      const update = prisma.support_tickets.updateMany.mock.calls[0][0];
      expect(update.where).toMatchObject({ id: 't1', routed_queue_id: 2, current_assignee_id: 'principal' });
      expect(update.data).toMatchObject({
        category: TicketCategory.FINANCIAL,
        subtopic: 'Refund Request',
        routed_role: 'FINANCE_CLERK',
        routed_queue_id: 5,
        lane_id: 2,
        leaf_node_key: 'f-refund-request',
        current_assignee_id: null,
        status: TicketStatus.OPEN,
      });
      const event = prisma.ticket_events.create.mock.calls[0][0].data;
      expect(event).toMatchObject({ event_type: 'MOVED', actor_user_id: 'principal', from_user_id: 'principal', to_user_id: null });
      expect(event.note).toBe('From General desk to Finance as "Refund Request". Reason: This is about a refund');
      expect(gateway.broadcastTicketMoved).toHaveBeenCalledWith(expect.anything(), {
        routed_queue_id: 2, routed_role: 'GENERAL_RESPONDENT', current_assignee_id: 'principal',
      });
      // The new desk hears about it (it is unclaimed there).
      expect(mockFcm.sendToUsers).toHaveBeenCalledWith(['clerk'], 'Support ticket moved to Finance', expect.any(String), expect.objectContaining({ type: 'SUPPORT_TICKET_MOVED' }));
    });

    it('tells the mover when the ticket has left their sight', async () => {
      routing.deskOptions.mockResolvedValue([{
        id: 5, name: 'Finance', category: TicketCategory.FINANCIAL, assignment: 'POOL', in_scope: true, members: [],
      }]);
      mockFlow.defaultLaneId.mockResolvedValue(2);
      // Principal sits on desk 2 only; the ticket is now on desk 5, unassigned.
      const res = await mover.moveTicket('t1', { queueId: 5, reason: 'fees question' }, principal);
      expect(res.viewer_can_view).toBe(false);
      const adminRes = await mover.moveTicket('t1', { queueId: 5, reason: 'fees question' }, admin);
      expect(adminRes.viewer_can_view).toBe(true);
    });

    it('requires a reason and exactly one destination', async () => {
      await expect(mover.moveTicket('t1', { leafKey: 'x', reason: ' ' }, principal)).rejects.toThrow('reason');
      await expect(mover.moveTicket('t1', { reason: 'wrong desk' }, principal)).rejects.toThrow('topic or a desk');
      await expect(mover.moveTicket('t1', { leafKey: 'x', queueId: 5, reason: 'wrong desk' }, principal)).rejects.toThrow('topic or a desk');
    });

    it('refuses staff who neither hold the ticket nor sit on its desk', async () => {
      routing.queueIdsFor.mockResolvedValue([]);
      await expect(mover.moveTicket('t1', { queueId: 5, reason: 'wrong desk' }, outsider)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.support_tickets.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a closed ticket', async () => {
      prisma.support_tickets.findUnique.mockResolvedValue({ ...academics, status: TicketStatus.CLOSED });
      await expect(mover.moveTicket('t1', { queueId: 5, reason: 'wrong desk' }, admin)).rejects.toThrow('closed');
    });

    describe('scope', () => {
      const blindDesk = {
        id: 5, name: 'Finance', category: TicketCategory.FINANCIAL, assignment: 'POOL', in_scope: false,
        members: [{ id: 'clerk', full_name: 'Clerk', in_scope: false }],
      };

      it('refuses a desk nobody there can see the student at, for non-admins', async () => {
        routing.deskOptions.mockResolvedValue([blindDesk]);
        await expect(mover.moveTicket('t1', { queueId: 5, reason: 'wrong desk' }, principal)).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('asks a super admin to confirm the override, then records it in the thread', async () => {
        routing.deskOptions.mockResolvedValue([blindDesk]);
        mockFlow.defaultLaneId.mockResolvedValue(2);
        await expect(mover.moveTicket('t1', { queueId: 5, reason: 'wrong desk' }, admin)).rejects.toThrow(/Confirm/);
        expect(prisma.support_tickets.updateMany).not.toHaveBeenCalled();

        await mover.moveTicket('t1', { queueId: 5, reason: 'wrong desk', overrideScope: true }, admin);
        const event = prisma.ticket_events.create.mock.calls[0][0].data;
        expect(event.note).toContain('super admin override');
      });

      it('places no limit on a ticket with no student', async () => {
        prisma.support_tickets.findUnique.mockResolvedValue({ ...academics, student_id: null, students: null });
        routing.deskOptions.mockResolvedValue([{ ...blindDesk, in_scope: true, members: [{ ...blindDesk.members[0], in_scope: true }] }]);
        mockFlow.defaultLaneId.mockResolvedValue(2);
        await mover.moveTicket('t1', { queueId: 5, reason: 'wrong desk' }, principal);
        expect(routing.deskOptions).toHaveBeenCalledWith(null, 5);
      });
    });

    it('a desk in another category switches lane and clears the topic', async () => {
      routing.deskOptions.mockResolvedValue([{
        id: 5, name: 'Finance', category: TicketCategory.FINANCIAL, assignment: 'POOL', in_scope: true,
        members: [{ id: 'clerk', full_name: 'Clerk', in_scope: true }],
      }]);
      mockFlow.defaultLaneId.mockResolvedValue(2);
      (prisma as any).users.findUnique.mockResolvedValue({ full_name: 'Clerk', username: 'clerk' });
      await mover.moveTicket('t1', { queueId: 5, targetUserId: 'clerk', reason: 'wrong desk' }, principal);
      const data = prisma.support_tickets.updateMany.mock.calls[0][0].data;
      expect(data).toMatchObject({
        category: TicketCategory.FINANCIAL,
        routed_role: 'FINANCE_CLERK',
        lane_id: 2,
        leaf_node_key: null,
        routed_queue_id: 5,
        current_assignee_id: 'clerk',
        status: TicketStatus.ASSIGNED,
      });
      expect(prisma.ticket_events.create.mock.calls[0][0].data.note).toBe('From General desk to Finance (Clerk). Reason: wrong desk');
    });

    it('a desk in the same category keeps the lane and topic', async () => {
      routing.deskOptions.mockResolvedValue([{
        id: 7, name: 'Senior section', category: TicketCategory.GENERAL, assignment: 'POOL', in_scope: true,
        members: [{ id: 'hos', full_name: 'HoS', in_scope: true }],
      }]);
      await mover.moveTicket('t1', { queueId: 7, reason: 'their section' }, principal);
      const data = prisma.support_tickets.updateMany.mock.calls[0][0].data;
      expect(data).toMatchObject({ lane_id: 1, leaf_node_key: 'gc-academics-classwork', routed_queue_id: 7, current_assignee_id: null });
      expect(mockFlow.defaultLaneId).not.toHaveBeenCalled();
    });

    it('fails cleanly when the ticket changed underneath', async () => {
      routing.deskOptions.mockResolvedValue([{
        id: 7, name: 'Senior section', category: TicketCategory.GENERAL, assignment: 'POOL', in_scope: true, members: [],
      }]);
      prisma.support_tickets.updateMany.mockResolvedValue({ count: 0 });
      await expect(mover.moveTicket('t1', { queueId: 7, reason: 'their section' }, principal)).rejects.toThrow(/changed/);
      expect(prisma.ticket_events.create).not.toHaveBeenCalled();
    });

    it('refuses a move to where the ticket already is', async () => {
      routing.deskOptions.mockResolvedValue([{
        id: 2, name: 'General desk', category: TicketCategory.GENERAL, assignment: 'POOL', in_scope: true,
        members: [{ id: 'principal', full_name: 'Principal P', in_scope: true }],
      }]);
      await expect(mover.moveTicket('t1', { queueId: 2, targetUserId: 'principal', reason: 'same' }, principal)).rejects.toThrow('already');
    });

    it('lists only in-scope desks and people for non-admins', async () => {
      mockFlow.moveTopics.mockResolvedValue({ version: 3, lanes: [] });
      routing.deskOptions.mockResolvedValue([
        { id: 5, in_scope: false, members: [{ id: 'a', in_scope: false }] },
        { id: 7, in_scope: true, members: [{ id: 'b', in_scope: true }, { id: 'c', in_scope: false }] },
      ]);
      const res = await mover.listMoveOptions('t1', principal);
      expect(res.desks).toEqual([{ id: 7, in_scope: true, members: [{ id: 'b', in_scope: true }] }]);
      expect(res.can_override_scope).toBe(false);
      const adminRes = await mover.listMoveOptions('t1', admin);
      expect(adminRes.desks).toHaveLength(2);
    });
  });
});
