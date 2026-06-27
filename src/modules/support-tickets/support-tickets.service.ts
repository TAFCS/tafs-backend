import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  forwardRef,
} from '@nestjs/common';
import {
  ChatMessageType,
  MessageStatus,
  Prisma,
  StaffRole,
  TicketCategory,
  TicketEventType,
  TicketStatus,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  IJwtParentPayload,
  IJwtStaffPayload,
} from '../auth/interfaces/jwt-payload.interface';
import { ChatGateway } from '../chat/chat.gateway';
import { FcmService } from '../../common/fcm/fcm.service';
import {
  ORIGINATION_OPTIONS,
  closedTicketVisibilityWhere,
  pickPrincipal,
  principalLookupWhere,
} from '../../common/support-ticket-routing';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { CreateTicketMessageDto } from './dto/create-ticket-message.dto';
import { ReviewTicketMessageDto } from './dto/review-ticket-message.dto';
import { CloseTicketDto } from './dto/close-ticket.dto';

const MAX_OPEN_TICKETS_PER_FAMILY = 10;

const ticketInclude = {
  families: { select: { id: true, household_name: true } },
  students: {
    select: {
      cc: true,
      full_name: true,
      photograph_url: true,
      photo_blue_bg_url: true,
      gr_number: true,
      primary_phone: true,
      whatsapp_number: true,
      whatsapp_country_code: true,
      classes: { select: { description: true } },
      sections: { select: { description: true } },
      campuses: { select: { campus_name: true } },
    },
  },
  current_assignee: {
    select: { id: true, full_name: true, username: true, role: true },
  },
} satisfies Prisma.support_ticketsInclude;

@Injectable()
export class SupportTicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fcmService: FcmService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,
  ) {}

  getOriginationOptions() {
    return ORIGINATION_OPTIONS;
  }

  async listParentTickets(
    parent: IJwtParentPayload,
    status?: 'open' | 'closed',
    take = 50,
    skip = 0,
  ) {
    const statusFilter =
      status === 'closed'
        ? { status: TicketStatus.CLOSED }
        : status === 'open'
          ? { status: { in: [TicketStatus.OPEN, TicketStatus.ASSIGNED] } }
          : {};

    const [items, total] = await Promise.all([
      this.prisma.support_tickets.findMany({
        where: { family_id: parent.familyId, ...statusFilter },
        include: ticketInclude,
        orderBy: { last_message_at: 'desc' },
        take,
        skip,
      }),
      this.prisma.support_tickets.count({
        where: { family_id: parent.familyId, ...statusFilter },
      }),
    ]);

    return { items, total, take, skip };
  }

  async listMyQueue(staff: IJwtStaffPayload, take = 50, skip = 0) {
    const where = {
      status: { in: [TicketStatus.OPEN, TicketStatus.ASSIGNED] },
      current_assignee_id: staff.sub,
    };

    const [items, total] = await Promise.all([
      this.prisma.support_tickets.findMany({
        where,
        include: ticketInclude,
        orderBy: { last_message_at: 'desc' },
        take,
        skip,
      }),
      this.prisma.support_tickets.count({ where }),
    ]);

    return { items, total, take, skip };
  }

  async listFinanceQueue(staff: IJwtStaffPayload, take = 50, skip = 0) {
    if (staff.role !== 'FINANCE_CLERK' && staff.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Finance queue access denied');
    }

    const where = {
      category: TicketCategory.FINANCIAL,
      routed_role: StaffRole.FINANCE_CLERK,
      status: { in: [TicketStatus.OPEN, TicketStatus.ASSIGNED] },
    };

    const [items, total] = await Promise.all([
      this.prisma.support_tickets.findMany({
        where,
        include: ticketInclude,
        orderBy: { last_message_at: 'desc' },
        take,
        skip,
      }),
      this.prisma.support_tickets.count({ where }),
    ]);

    return { items, total, take, skip };
  }

  async listOversightQueue(staff: IJwtStaffPayload, take = 50, skip = 0) {
    if (staff.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Super Admin access required');
    }

    const where = {
      status: { in: [TicketStatus.OPEN, TicketStatus.ASSIGNED] },
    };

    const [items, total] = await Promise.all([
      this.prisma.support_tickets.findMany({
        where,
        include: ticketInclude,
        orderBy: { last_message_at: 'desc' },
        take,
        skip,
      }),
      this.prisma.support_tickets.count({ where }),
    ]);

    return { items, total, take, skip };
  }

  async listClosedTickets(staff: IJwtStaffPayload, take = 50, skip = 0) {
    const where = closedTicketVisibilityWhere(staff);

    const [items, total] = await Promise.all([
      this.prisma.support_tickets.findMany({
        where,
        include: ticketInclude,
        orderBy: { closed_at: 'desc' },
        take,
        skip,
      }),
      this.prisma.support_tickets.count({ where }),
    ]);

    return { items, total, take, skip };
  }

  async listPendingApprovals(staff: IJwtStaffPayload, take = 50, skip = 0) {
    if (staff.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Super Admin access required');
    }

    return this.prisma.ticket_messages.findMany({
      where: { status: MessageStatus.PENDING, sender_type: 'STAFF' },
      orderBy: { created_at: 'asc' },
      take,
      skip,
      include: {
        sender_user: { select: { id: true, full_name: true, role: true } },
        ticket: {
          include: {
            families: { select: { id: true, household_name: true } },
            students: { select: { cc: true, full_name: true } },
          },
        },
      },
    });
  }

  async getTicketById(
    id: string,
    actor: IJwtStaffPayload | IJwtParentPayload,
    take = 100,
    skip = 0,
  ) {
    const ticket = await this.prisma.support_tickets.findUnique({
      where: { id },
      include: ticketInclude,
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    this.assertCanViewTicket(ticket, actor);

    const messageWhere = this.messageVisibilityWhere(actor, ticket);

    const [messages, messageTotal] = await Promise.all([
      this.prisma.ticket_messages.findMany({
        where: { ticket_id: id, ...messageWhere },
        orderBy: { created_at: 'desc' },
        take,
        skip,
        include: {
          sender_user: { select: { id: true, full_name: true, role: true } },
          sender_guardian: { select: { id: true, full_name: true } },
          reviewer: { select: { id: true, full_name: true } },
        },
      }),
      this.prisma.ticket_messages.count({
        where: { ticket_id: id, ...messageWhere },
      }),
    ]);

    const eventWhere = this.eventVisibilityWhere(actor);

    const events = await this.prisma.ticket_events.findMany({
      where: { ticket_id: id, ...eventWhere },
      orderBy: { created_at: 'asc' },
      include: {
        actor_user: { select: { id: true, full_name: true } },
        from_user: { select: { id: true, full_name: true } },
        to_user: { select: { id: true, full_name: true } },
      },
    });

    return { ...ticket, messages, messageTotal, events };
  }

  async createTicket(parent: IJwtParentPayload, dto: CreateTicketDto) {
    const openCount = await this.prisma.support_tickets.count({
      where: {
        family_id: parent.familyId,
        status: { in: [TicketStatus.OPEN, TicketStatus.ASSIGNED] },
      },
    });
    if (openCount >= MAX_OPEN_TICKETS_PER_FAMILY) {
      throw new BadRequestException(
        `Maximum of ${MAX_OPEN_TICKETS_PER_FAMILY} open tickets allowed`,
      );
    }

    const routing = await this.resolveRouting(parent.familyId, dto);

    const guardian = await this.prisma.guardians.findFirst({
      where: {
        student_guardians: {
          some: { students: { family_id: parent.familyId, deleted_at: null } },
        },
        deleted_at: null,
      },
      orderBy: { id: 'asc' },
    });

    const ticket = await this.prisma.$transaction(async (tx) => {
      const created = await tx.support_tickets.create({
        data: {
          family_id: parent.familyId,
          category: dto.category,
          subtopic: dto.subtopic,
          student_id: dto.studentId ?? null,
          description: dto.description,
          status: routing.status,
          current_assignee_id: routing.assigneeId,
          routed_role: routing.routedRole,
          opened_by_guardian_id: guardian?.id ?? null,
          last_message_snippet: dto.description.slice(0, 50),
        },
        include: ticketInclude,
      });

      if (dto.mediaMetadata) {
        await tx.ticket_messages.create({
          data: {
            ticket_id: created.id,
            sender_type: 'GUARDIAN',
            sender_guardian_id: guardian?.id ?? null,
            message_type: ChatMessageType.DOCUMENT,
            content: dto.description,
            media_metadata: dto.mediaMetadata as object,
            status: MessageStatus.APPROVED,
          },
        });
      } else {
        await tx.ticket_messages.create({
          data: {
            ticket_id: created.id,
            sender_type: 'GUARDIAN',
            sender_guardian_id: guardian?.id ?? null,
            message_type: ChatMessageType.TEXT,
            content: dto.description,
            status: MessageStatus.APPROVED,
          },
        });
      }

      await tx.ticket_events.create({
        data: {
          ticket_id: created.id,
          event_type: TicketEventType.CREATED,
          actor_guardian_id: guardian?.id ?? null,
        },
      });

      return created;
    });

    await this.chatGateway.broadcastTicketCreated(ticket);
    return ticket;
  }

  async claimTicket(ticketId: string, staff: IJwtStaffPayload) {
    if (staff.role !== 'FINANCE_CLERK') {
      throw new ForbiddenException('Only finance clerks can claim tickets');
    }

    const result = await this.prisma.support_tickets.updateMany({
      where: {
        id: ticketId,
        category: TicketCategory.FINANCIAL,
        status: TicketStatus.OPEN,
        current_assignee_id: null,
      },
      data: {
        current_assignee_id: staff.sub,
        status: TicketStatus.ASSIGNED,
      },
    });

    if (result.count === 0) {
      throw new ConflictException('Ticket already claimed or unavailable');
    }

    const ticket = await this.prisma.support_tickets.findUniqueOrThrow({
      where: { id: ticketId },
      include: ticketInclude,
    });

    await this.prisma.ticket_events.create({
      data: {
        ticket_id: ticketId,
        event_type: TicketEventType.CLAIMED,
        actor_user_id: staff.sub,
        to_user_id: staff.sub,
      },
    });

    await this.chatGateway.broadcastTicketClaimed(ticket);
    return ticket;
  }

  async transferTicket(
    ticketId: string,
    targetUserId: string,
    staff: IJwtStaffPayload,
  ) {
    if (staff.role !== 'FINANCE_CLERK') {
      throw new ForbiddenException('Only finance clerks can transfer tickets');
    }

    const target = await this.prisma.users.findFirst({
      where: {
        id: targetUserId,
        role: StaffRole.FINANCE_CLERK,
        is_active: true,
        deleted_at: null,
      },
    });
    if (!target) {
      throw new BadRequestException('Target must be an active finance clerk');
    }
    if (targetUserId === staff.sub) {
      throw new BadRequestException('Cannot transfer to yourself');
    }

    const result = await this.prisma.support_tickets.updateMany({
      where: {
        id: ticketId,
        category: TicketCategory.FINANCIAL,
        current_assignee_id: staff.sub,
        status: { in: [TicketStatus.OPEN, TicketStatus.ASSIGNED] },
      },
      data: { current_assignee_id: targetUserId },
    });

    if (result.count === 0) {
      throw new ConflictException('Transfer failed — you are not the current assignee');
    }

    const ticket = await this.prisma.support_tickets.findUniqueOrThrow({
      where: { id: ticketId },
      include: ticketInclude,
    });

    await this.prisma.ticket_events.create({
      data: {
        ticket_id: ticketId,
        event_type: TicketEventType.TRANSFERRED,
        actor_user_id: staff.sub,
        from_user_id: staff.sub,
        to_user_id: targetUserId,
      },
    });

    await this.chatGateway.broadcastTicketTransferred(ticket, staff.sub, targetUserId);
    return ticket;
  }

  async forwardTicket(
    ticketId: string,
    targetUserId: string,
    staff: IJwtStaffPayload,
  ) {
    if (staff.role !== 'GENERAL_RESPONDENT') {
      throw new ForbiddenException('Only the General Respondent can forward tickets');
    }

    const ticket = await this.prisma.support_tickets.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.current_assignee_id !== staff.sub) {
      throw new ForbiddenException('You are not the current assignee');
    }
    if (ticket.status === TicketStatus.CLOSED) {
      throw new BadRequestException('Cannot forward a closed ticket');
    }

    const target = await this.prisma.users.findFirst({
      where: { id: targetUserId, is_active: true, deleted_at: null },
    });
    if (!target) {
      throw new BadRequestException('Target staff member not found');
    }

    const result = await this.prisma.support_tickets.updateMany({
      where: {
        id: ticketId,
        current_assignee_id: staff.sub,
        status: { not: TicketStatus.CLOSED },
      },
      data: { current_assignee_id: targetUserId, status: TicketStatus.ASSIGNED },
    });

    if (result.count === 0) {
      throw new ConflictException('Ticket no longer assigned to you');
    }

    const updated = await this.prisma.support_tickets.findUniqueOrThrow({
      where: { id: ticketId },
      include: ticketInclude,
    });

    await this.prisma.ticket_events.create({
      data: {
        ticket_id: ticketId,
        event_type: TicketEventType.FORWARDED,
        actor_user_id: staff.sub,
        from_user_id: staff.sub,
        to_user_id: targetUserId,
      },
    });

    await this.chatGateway.broadcastTicketForwarded(updated, staff.sub, targetUserId);
    return updated;
  }

  async createStaffMessage(
    ticketId: string,
    staff: IJwtStaffPayload,
    dto: CreateTicketMessageDto,
  ) {
    const ticket = await this.prisma.support_tickets.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    this.assertCanPostToTicket(ticket, staff);

    if (staff.role === 'SUPER_ADMIN') {
      const snippet = this.messageSnippet(dto.messageType, dto.content);
      const now = new Date();

      const message = await this.prisma.$transaction(async (tx) => {
        const created = await tx.ticket_messages.create({
          data: {
            ticket_id: ticketId,
            sender_type: 'STAFF',
            sender_user_id: staff.sub,
            message_type: dto.messageType,
            content: dto.content,
            media_metadata: (dto.mediaMetadata ?? undefined) as object | undefined,
            status: MessageStatus.APPROVED,
            reviewed_by: staff.sub,
            reviewed_at: now,
          },
          include: {
            sender_user: { select: { id: true, full_name: true, role: true } },
            reviewer: { select: { id: true, full_name: true } },
          },
        });

        await tx.support_tickets.update({
          where: { id: ticketId },
          data: {
            last_message_at: now,
            last_message_snippet: snippet,
            last_staff_snippet: snippet,
            last_staff_sender_id: staff.sub,
            last_staff_sender_name: created.sender_user?.full_name ?? null,
            unread_by_parent: { increment: 1 },
          },
        });

        await tx.ticket_events.create({
          data: {
            ticket_id: ticketId,
            event_type: TicketEventType.REPLY_APPROVED,
            actor_user_id: staff.sub,
          },
        });

        return created;
      });

      await this.deliverApprovedStaffMessage(ticket, message);
      return message;
    }

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.ticket_messages.create({
        data: {
          ticket_id: ticketId,
          sender_type: 'STAFF',
          sender_user_id: staff.sub,
          message_type: dto.messageType,
          content: dto.content,
          media_metadata: (dto.mediaMetadata ?? undefined) as object | undefined,
          status: MessageStatus.PENDING,
        },
        include: {
          sender_user: { select: { id: true, full_name: true, role: true } },
        },
      });

      await tx.ticket_events.create({
        data: {
          ticket_id: ticketId,
          event_type: TicketEventType.REPLY_SUBMITTED,
          actor_user_id: staff.sub,
        },
      });

      return created;
    });

    await this.chatGateway.broadcastReplyPendingApproval(message, ticket);
    return message;
  }

  async createParentMessage(
    ticketId: string,
    parent: IJwtParentPayload,
    dto: CreateTicketMessageDto,
  ) {
    const ticket = await this.prisma.support_tickets.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.family_id !== parent.familyId) {
      throw new ForbiddenException('Access denied');
    }
    if (ticket.status === TicketStatus.CLOSED) {
      throw new BadRequestException('Cannot message a closed ticket');
    }

    const guardian = await this.prisma.guardians.findFirst({
      where: {
        student_guardians: {
          some: { students: { family_id: parent.familyId, deleted_at: null } },
        },
        deleted_at: null,
      },
      orderBy: { id: 'asc' },
    });

    const snippet =
      dto.messageType === ChatMessageType.TEXT
        ? dto.content.slice(0, 50)
        : `[${dto.messageType}]`;

    const result = await this.prisma.$transaction(async (tx) => {
      const message = await tx.ticket_messages.create({
        data: {
          ticket_id: ticketId,
          sender_type: 'GUARDIAN',
          sender_guardian_id: guardian?.id ?? null,
          message_type: dto.messageType,
          content: dto.content,
          media_metadata: (dto.mediaMetadata ?? undefined) as object | undefined,
          status: MessageStatus.APPROVED,
        },
      });

      const updatedTicket = await tx.support_tickets.update({
        where: { id: ticketId },
        data: {
          last_message_at: new Date(),
          last_message_snippet: snippet,
          last_family_snippet: snippet,
          last_family_sender_name: guardian?.full_name ?? null,
          unread_by_staff: { increment: 1 },
        },
        include: ticketInclude,
      });

      return { message, ticket: updatedTicket };
    });

    await this.chatGateway.broadcastTicketMessageToStaff(
      result.ticket,
      result.message,
    );
    return result.message;
  }

  async reviewReply(
    messageId: string,
    dto: ReviewTicketMessageDto,
    superAdmin: IJwtStaffPayload,
  ) {
    if (superAdmin.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Super Admin access required');
    }
    if (dto.status !== 'APPROVED' && dto.status !== 'REJECTED') {
      throw new BadRequestException('Status must be APPROVED or REJECTED');
    }
    if (dto.status === MessageStatus.REJECTED && !dto.comment?.trim()) {
      throw new BadRequestException('Rejection reason is required');
    }

    const message = await this.prisma.ticket_messages.findUnique({
      where: { id: messageId },
      include: { ticket: true, sender_user: true },
    });
    if (!message) throw new NotFoundException('Message not found');
    if (message.status !== MessageStatus.PENDING) {
      throw new BadRequestException('Reply has already been reviewed');
    }

    const snippet = this.messageSnippet(message.message_type, message.content);

    const updated = await this.prisma.$transaction(async (tx) => {
      const updateResult = await tx.ticket_messages.updateMany({
        where: { id: messageId, status: MessageStatus.PENDING },
        data: {
          status: dto.status,
          review_comment:
            dto.status === MessageStatus.REJECTED
              ? dto.comment!.trim()
              : dto.comment,
          reviewed_by: superAdmin.sub,
          reviewed_at: new Date(),
        },
      });
      if (updateResult.count === 0) {
        throw new ConflictException('Reply has already been reviewed');
      }

      const reviewed = await tx.ticket_messages.findUniqueOrThrow({
        where: { id: messageId },
        include: {
          sender_user: { select: { id: true, full_name: true, role: true } },
          reviewer: { select: { id: true, full_name: true } },
        },
      });

      if (dto.status === MessageStatus.APPROVED) {
        await tx.support_tickets.update({
          where: { id: message.ticket_id },
          data: {
            last_message_at: new Date(),
            last_message_snippet: snippet,
            last_staff_snippet: snippet,
            last_staff_sender_id: message.sender_user_id,
            last_staff_sender_name: message.sender_user?.full_name ?? null,
            unread_by_parent: { increment: 1 },
          },
        });
      }

      await tx.ticket_events.create({
        data: {
          ticket_id: message.ticket_id,
          event_type:
            dto.status === MessageStatus.APPROVED
              ? TicketEventType.REPLY_APPROVED
              : TicketEventType.REPLY_REJECTED,
          actor_user_id: superAdmin.sub,
          note: dto.comment,
        },
      });

      return reviewed;
    });

    if (dto.status === MessageStatus.APPROVED) {
      await this.deliverApprovedStaffMessage(message.ticket, updated);
    } else {
      await this.chatGateway.broadcastReplyRejected(
        message.ticket_id,
        message.sender_user_id!,
        dto.comment,
        updated,
      );
    }

    return updated;
  }

  async closeByStaff(ticketId: string, staff: IJwtStaffPayload, dto: CloseTicketDto) {
    const ticket = await this.prisma.support_tickets.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.current_assignee_id !== staff.sub) {
      throw new ForbiddenException('You are not the assigned responder');
    }
    this.assertCanPostToTicket(ticket, staff);

    const updated = await this.closeTicket(
      ticketId,
      TicketEventType.CLOSED_BY_STAFF,
      { userId: staff.sub },
      dto.note,
    );
    await this.chatGateway.broadcastTicketClosed(updated);
    return updated;
  }

  async closeByParent(
    ticketId: string,
    parent: IJwtParentPayload,
    dto: CloseTicketDto,
  ) {
    const ticket = await this.prisma.support_tickets.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.family_id !== parent.familyId) {
      throw new ForbiddenException('Access denied');
    }

    const guardian = await this.prisma.guardians.findFirst({
      where: {
        student_guardians: {
          some: { students: { family_id: parent.familyId, deleted_at: null } },
        },
        deleted_at: null,
      },
      orderBy: { id: 'asc' },
    });

    const updated = await this.closeTicket(
      ticketId,
      TicketEventType.CLOSED_BY_PARENT,
      { guardianId: guardian?.id ?? null },
      dto.note,
    );
    await this.chatGateway.broadcastTicketClosed(updated);
    return updated;
  }

  async markRead(
    ticketId: string,
    actor: IJwtStaffPayload | IJwtParentPayload,
  ) {
    const ticket = await this.prisma.support_tickets.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    this.assertCanViewTicket(ticket, actor);

    if (actor.userType === 'PARENT') {
      return this.prisma.support_tickets.update({
        where: { id: ticketId },
        data: {
          unread_by_parent: 0,
          parent_last_read_at: new Date(),
        },
      });
    }

    return this.prisma.support_tickets.update({
      where: { id: ticketId },
      data: {
        unread_by_staff: 0,
        staff_last_read_at: new Date(),
      },
    });
  }

  /** Used by ChatGateway for socket sends. */
  async sendTicketMessageFromSocket(
    ticketId: string,
    payload: IJwtStaffPayload | IJwtParentPayload,
    dto: CreateTicketMessageDto,
  ) {
    if (payload.userType === 'STAFF') {
      return this.createStaffMessage(ticketId, payload, dto);
    }
    return this.createParentMessage(ticketId, payload, dto);
  }

  private async closeTicket(
    ticketId: string,
    eventType: TicketEventType,
    actor: { userId?: string; guardianId?: number | null },
    note?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.support_tickets.update({
        where: { id: ticketId },
        data: {
          status: TicketStatus.CLOSED,
          closed_at: new Date(),
          closed_by_user_id: actor.userId ?? null,
          closed_by_guardian_id: actor.guardianId ?? null,
        },
        include: ticketInclude,
      });

      await tx.ticket_events.create({
        data: {
          ticket_id: ticketId,
          event_type: eventType,
          actor_user_id: actor.userId ?? null,
          actor_guardian_id: actor.guardianId ?? null,
          note,
        },
      });

      return updated;
    });
  }

  private async resolveRouting(familyId: number, dto: CreateTicketDto) {
    if (dto.category === TicketCategory.FINANCIAL) {
      if (dto.studentId) {
        await this.assertStudentInFamily(dto.studentId, familyId);
      }
      return {
        routedRole: StaffRole.FINANCE_CLERK,
        assigneeId: null as string | null,
        status: TicketStatus.OPEN,
      };
    }

    if (dto.studentId) {
      const student = await this.assertStudentInFamily(dto.studentId, familyId);
      if (!student.campus_id || !student.class_id) {
        throw new UnprocessableEntityException(
          'Student is missing campus or class assignment',
        );
      }

      const candidates = await this.prisma.users.findMany({
        where: principalLookupWhere(student.campus_id, student.class_id),
        orderBy: { created_at: 'asc' },
      });
      const principal = pickPrincipal(candidates);
      if (!principal) {
        throw new UnprocessableEntityException(
          'No principal found for this student campus and class',
        );
      }

      return {
        routedRole: StaffRole.PRINCIPAL,
        assigneeId: principal.id,
        status: TicketStatus.ASSIGNED,
      };
    }

    const respondent = await this.prisma.users.findFirst({
      where: {
        role: StaffRole.GENERAL_RESPONDENT,
        is_active: true,
        deleted_at: null,
      },
      orderBy: { created_at: 'asc' },
    });
    if (!respondent) {
      throw new UnprocessableEntityException(
        'General Respondent account is not configured',
      );
    }

    return {
      routedRole: StaffRole.GENERAL_RESPONDENT,
      assigneeId: respondent.id,
      status: TicketStatus.ASSIGNED,
    };
  }

  private async assertStudentInFamily(studentId: number, familyId: number) {
    const student = await this.prisma.students.findFirst({
      where: { cc: studentId, family_id: familyId, deleted_at: null },
    });
    if (!student) {
      throw new ForbiddenException('Student not found in your family');
    }
    return student;
  }

  private eventVisibilityWhere(
    actor: IJwtStaffPayload | IJwtParentPayload,
  ): Prisma.ticket_eventsWhereInput {
    if (actor.userType !== 'PARENT') {
      return {};
    }

    return {
      event_type: {
        in: [
          TicketEventType.CREATED,
          TicketEventType.CLOSED_BY_STAFF,
          TicketEventType.CLOSED_BY_PARENT,
        ],
      },
    };
  }

  private messageVisibilityWhere(
    actor: IJwtStaffPayload | IJwtParentPayload,
    ticket: { id: string },
  ): Prisma.ticket_messagesWhereInput {
    if (actor.userType === 'PARENT') {
      return {
        OR: [
          { sender_type: 'GUARDIAN' },
          { sender_type: 'STAFF', status: MessageStatus.APPROVED },
        ],
      };
    }

    const staff = actor as IJwtStaffPayload;
    if (staff.role === 'SUPER_ADMIN') {
      return {};
    }

    return {
      OR: [
        { sender_type: 'GUARDIAN' },
        { sender_type: 'STAFF', status: MessageStatus.APPROVED },
        { sender_type: 'STAFF', sender_user_id: staff.sub },
      ],
    };
  }

  async assertCanEnterTicketRoom(
    ticketId: string,
    actor: IJwtStaffPayload | IJwtParentPayload,
  ) {
    const ticket = await this.prisma.support_tickets.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    this.assertCanViewTicket(ticket, actor);
  }

  private assertCanViewTicket(
    ticket: {
      family_id: number;
      status: TicketStatus;
      current_assignee_id: string | null;
      category: TicketCategory;
      routed_role: StaffRole;
    },
    actor: IJwtStaffPayload | IJwtParentPayload,
  ) {
    if (actor.userType === 'PARENT') {
      if (ticket.family_id !== actor.familyId) {
        throw new ForbiddenException('Access denied');
      }
      return;
    }

    const staff = actor as IJwtStaffPayload;
    if (staff.role === 'SUPER_ADMIN') return;

    if (ticket.status === TicketStatus.CLOSED) {
      const where = closedTicketVisibilityWhere(staff);
      if ('id' in where && where.id === '__none__') {
        throw new ForbiddenException('Access denied');
      }
      if ('routed_role' in where && where.routed_role !== ticket.routed_role) {
        throw new ForbiddenException('Access denied');
      }
      return;
    }

    if (ticket.current_assignee_id === staff.sub) return;

    if (
      staff.role === 'FINANCE_CLERK' &&
      ticket.category === TicketCategory.FINANCIAL &&
      ticket.routed_role === StaffRole.FINANCE_CLERK
    ) {
      return;
    }

    throw new ForbiddenException('Access denied');
  }

  private messageSnippet(messageType: ChatMessageType, content: string): string {
    return messageType === ChatMessageType.TEXT
      ? content.slice(0, 50)
      : `[${messageType}]`;
  }

  private async deliverApprovedStaffMessage(
    ticket: { id: string; family_id: number },
    message: {
      id: string;
      message_type: ChatMessageType;
      content: string;
    },
  ) {
    const fullTicket = await this.prisma.support_tickets.findUniqueOrThrow({
      where: { id: ticket.id },
      include: ticketInclude,
    });

    await this.chatGateway.broadcastApprovedTicketMessage(fullTicket, message);
    const parentInTicket = this.chatGateway.isParentInTicketRoom(
      ticket.family_id,
      ticket.id,
    );
    if (!parentInTicket) {
      await this.fcmService.sendToFamily(
        ticket.family_id,
        'New reply on your query',
        message.message_type === ChatMessageType.TEXT
          ? message.content
          : `New ${message.message_type.toLowerCase()} received`,
        {
          type: 'SUPPORT_TICKET_MESSAGE',
          ticketId: ticket.id,
          messageId: message.id,
        },
      );
    }
  }

  private assertCanPostToTicket(
    ticket: {
      status: TicketStatus;
      current_assignee_id: string | null;
      category: TicketCategory;
    },
    staff: IJwtStaffPayload,
  ) {
    if (ticket.status === TicketStatus.CLOSED) {
      throw new BadRequestException('Ticket is closed');
    }
    if (ticket.current_assignee_id !== staff.sub && staff.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('You are not the assigned responder');
    }
    if (
      ticket.category === TicketCategory.FINANCIAL &&
      staff.role !== 'FINANCE_CLERK' &&
      staff.role !== 'SUPER_ADMIN'
    ) {
      throw new ForbiddenException('Only finance clerks can respond to financial tickets');
    }
  }
}
