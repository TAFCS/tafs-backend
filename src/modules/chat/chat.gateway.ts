import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
  WsException,
} from '@nestjs/websockets';
import { Inject, forwardRef } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChatSenderType, ChatMessageType } from '@prisma/client';
import { FcmService } from '../../common/fcm/fcm.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import { SupportTicketsService } from '../support-tickets/support-tickets.service';

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
})
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // Track which admin sockets are actively viewing which family chat
  // Map<familyId, Set<socketId>> — for FCM suppression when admin is viewing.
  // Local-process-only; only used for same-process bookkeeping (enterChat/leaveChat UX),
  // not for cross-instance presence decisions (those use Socket.IO rooms, see below).
  private adminViewingFamily = new Map<number, Set<string>>();
  // Reverse: Map<socketId, familyId> — so we can clean up on disconnect
  private socketAdminViewing = new Map<string, number>();

  // Timers that force-disconnect a socket when its JWT naturally expires
  // (mid-session re-validation — auth is otherwise only checked at handshake).
  private expiryTimers = new Map<string, NodeJS.Timeout>();

    constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly fcmService: FcmService,
    private readonly auditLogs: AuditLogsService,
    @Inject(forwardRef(() => SupportTicketsService))
    private readonly supportTicketsService: SupportTicketsService,
  ) {}

  // ─── Socket.IO Middleware (runs BEFORE connection is established) ──────────
  // Using middleware instead of handleConnection+disconnect ensures clients
  // receive a proper connect_error with a typed message, stopping reconnect storms.
  afterInit(server: Server) {
    server.use((socket: Socket, next) => {
      try {
        const rawToken =
          socket.handshake.auth?.token ||
          socket.handshake.headers?.authorization?.split(' ')[1];

        if (!rawToken) {
          // Staff webapp uses httpOnly cookies — extract from header
          const cookieToken = this.extractTokenFromCookie(
            socket.handshake.headers.cookie,
          );
          if (!cookieToken) {
            return next(new Error('unauthorized'));
          }
          const payload = this.jwtService.verify(cookieToken);
          socket.data.tafsPayload = payload;
          return next();
        }

        const payload = this.jwtService.verify(rawToken);
        socket.data.tafsPayload = payload;
        return next();
      } catch (error: any) {
        const isExpired =
          error?.message?.includes('jwt expired') ||
          error?.name === 'TokenExpiredError';
        // Pass a typed error — clients check err.message to decide whether to refresh
        return next(new Error(isExpired ? 'token_expired' : 'unauthorized'));
      }
    });
  }

  async handleConnection(client: Socket) {
    // Auth is already verified by the server middleware in afterInit.
    // This hook only sets up rooms and presence tracking.
    const payload = client.data.tafsPayload;
    console.log('[ChatGateway] Connected:', payload.userType, payload.sub || payload.familyId);
    try {
      // JWT is only verified at handshake; force a clean reconnect (with a fresh
      // token) when it naturally expires instead of trusting a stale session forever.
      this.scheduleExpiryDisconnect(client, payload);

      if (payload.userType === 'STAFF') {
        // admin_inbox carries every family's live messages — only join it if the
        // staff member actually has chat-view permission (mirrors the REST
        // PoliciesGuard check on GET /chat/inbox), not just "any authenticated staff".
        if (this.canViewChats(payload)) {
          client.join('admin_inbox');
          console.log(`[ChatGateway] Staff joined admin_inbox: ${client.id}`);
        }
        client.join(`staff_inbox_${payload.sub}`);
        if (payload.role === 'FINANCE_CLERK') client.join('finance_queue');
        if (payload.role === 'SUPER_ADMIN') client.join('super_admin_approvals');
        if (payload.role === 'GENERAL_RESPONDENT') client.join('general_respondent_inbox');
      } else if (payload.userType === 'PARENT') {
        const familyId = Number(payload.familyId || payload.sub);
        if (isNaN(familyId)) {
          client.disconnect(true);
          return;
        }

        // Cluster-aware: adapter.rooms is kept in sync across all instances by the
        // Redis adapter, so this correctly reflects sockets connected to OTHER nodes too.
        const wasOnline = (this.server.sockets.adapter.rooms.get(`family_app_${familyId}`)?.size ?? 0) > 0;

        client.join(`family_app_${familyId}`);
        client.join('all_parents');

        // Join Grade and Section rooms for announcements
        const students = await this.prisma.students.findMany({
          where: { family_id: familyId, deleted_at: null },
          include: { classes: true, sections: true },
        });
        for (const student of students) {
          if (student.classes?.class_code) {
            client.join(`grade_${student.classes.class_code}`);
          }
          if (student.sections?.description) {
            client.join(`section_${student.sections.description}`);
          }
        }

        if (!wasOnline) {
          this.server
            .to('admin_inbox')
            .emit('userStatusChanged', { familyId, status: 'ONLINE' });
        }
        console.log(`[ChatGateway] Parent ${familyId} connected: ${client.id}`);
      }
    } catch (error: any) {
      console.warn('[ChatGateway] Room setup error:', error.message);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    console.log('[ChatGateway] Client disconnected:', client.id);

    const timer = this.expiryTimers.get(client.id);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(client.id);
    }

    // Socket.IO removes the disconnecting socket from all rooms (incl.
    // family_app_*) before this hook runs, and the redis adapter keeps that
    // room membership in sync cluster-wide — so this correctly detects
    // "family has no more connected devices ANYWHERE", not just this node.
    const payload = client.data.tafsPayload;
    if (payload?.userType === 'PARENT') {
      const familyId = Number(payload.familyId || payload.sub);
      if (!isNaN(familyId)) {
        const stillOnline = (this.server.sockets.adapter.rooms.get(`family_app_${familyId}`)?.size ?? 0) > 0;
        if (!stillOnline) {
          this.server.to('admin_inbox').emit('userStatusChanged', { familyId, status: 'OFFLINE' });
        }
      }
    }

    // Clean up admin viewing-family tracking
    const viewingFamilyId = this.socketAdminViewing.get(client.id);
    if (viewingFamilyId !== undefined) {
      this.socketAdminViewing.delete(client.id);
      const admins = this.adminViewingFamily.get(viewingFamilyId);
      if (admins) {
        admins.delete(client.id);
        if (admins.size === 0) {
          this.adminViewingFamily.delete(viewingFamilyId);
        }
      }
    }
    // Ticket room presence (parent_ticket_*) and all other rooms are left
    // automatically by Socket.IO/the redis adapter — no manual bookkeeping needed.
  }

  /** Force-disconnects the socket when its JWT naturally expires, so a
   * revoked/expired session can't keep live access indefinitely.
   *
   * Node's setTimeout max is 2^31-1 ms (~24.8 days). Longer JWTs overflow that
   * limit, which clamps the delay to 1ms and immediately kills the socket —
   * breaking realtime typing/messages. Clamp and reschedule until real expiry.
   */
  private static readonly MAX_TIMEOUT_MS = 2_147_483_647;

  private scheduleExpiryDisconnect(client: Socket, payload: { exp?: number }) {
    const existing = this.expiryTimers.get(client.id);
    if (existing) {
      clearTimeout(existing);
      this.expiryTimers.delete(client.id);
    }
    if (!payload.exp) return;

    const msUntilExpiry = payload.exp * 1000 - Date.now();
    if (msUntilExpiry <= 0) {
      client.disconnect(true);
      return;
    }

    const delay = Math.min(msUntilExpiry, ChatGateway.MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      this.expiryTimers.delete(client.id);
      const remaining = payload.exp! * 1000 - Date.now();
      if (remaining <= 0) {
        client.disconnect(true);
        return;
      }
      // Still valid — reschedule another capped chunk until true expiry.
      this.scheduleExpiryDisconnect(client, payload);
    }, delay);
    this.expiryTimers.set(client.id, timer);
  }

  private canViewChats(payload: { role?: string; permissions?: string[] }): boolean {
    if (payload.role === 'SUPER_ADMIN') return true;
    return (payload.permissions ?? []).includes('communication.view_chats');
  }

  @SubscribeMessage('getOnlineStatus')
  handleGetOnlineStatus() {
    // Cluster-aware: derived from Socket.IO room membership (synced by the redis
    // adapter) rather than a local-process-only map.
    const onlineIds: number[] = [];
    for (const roomName of this.server.sockets.adapter.rooms.keys()) {
      if (roomName.startsWith('family_app_')) {
        const familyId = Number(roomName.slice('family_app_'.length));
        if (!isNaN(familyId)) onlineIds.push(familyId);
      }
    }
    return { onlineFamilyIds: onlineIds };
  }

  @SubscribeMessage('enterChat')
  handleEnterChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { familyId: any },
  ) {
    const familyId = Number(data.familyId);
    const payload = client.data.tafsPayload;

    // Only parents join family_chat_* (FCM suppression when parent has chat open).
    // Staff must NOT join this room — it caused isParentInChatRoom() to always
    // return true while an admin had the webapp chat open, blocking all pushes.
    if (payload?.userType === 'PARENT') {
      client.join(`family_chat_${familyId}`);
    }

    if (payload?.userType === 'STAFF') {
      // Clean up previous admin view if switching conversations
      const previousFamilyId = this.socketAdminViewing.get(client.id);
      if (previousFamilyId !== undefined && previousFamilyId !== familyId) {
        const prevAdmins = this.adminViewingFamily.get(previousFamilyId);
        if (prevAdmins) {
          prevAdmins.delete(client.id);
          if (prevAdmins.size === 0) this.adminViewingFamily.delete(previousFamilyId);
        }
      }
      if (!this.adminViewingFamily.has(familyId)) {
        this.adminViewingFamily.set(familyId, new Set());
      }
      this.adminViewingFamily.get(familyId)!.add(client.id);
      this.socketAdminViewing.set(client.id, familyId);
    }

    console.log(`[ChatGateway] Socket ${client.id} entered chat for family ${familyId}`);
  }

  @SubscribeMessage('leaveChat')
  handleLeaveChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { familyId: any },
  ) {
    const familyId = Number(data.familyId);
    const payload = client.data.tafsPayload;

    if (payload?.userType === 'PARENT') {
      client.leave(`family_chat_${familyId}`);
    }

    if (payload?.userType === 'STAFF') {
      this.socketAdminViewing.delete(client.id);
      const admins = this.adminViewingFamily.get(familyId);
      if (admins) {
        admins.delete(client.id);
        if (admins.size === 0) this.adminViewingFamily.delete(familyId);
      }
    }

    console.log(`[ChatGateway] Socket ${client.id} left chat for family ${familyId}`);
  }

  private extractTokenFromCookie(cookieString?: string): string | null {
    if (!cookieString) return null;
    const match = cookieString.match(/(?:^|;)\s*tafs_access=([^;]+)/);
    return match ? match[1] : null;
  }

  /**
   * Checks whether any admin is currently actively viewing this family's chat window.
   * Used to suppress FCM push notifications when the admin is already present.
   */
  private isAdminViewingFamily(familyId: number): boolean {
    const admins = this.adminViewingFamily.get(familyId);
    return admins !== undefined && admins.size > 0;
  }

  async broadcastNewMessage(
    familyId: number,
    newMessage: {
      id: string;
      message_type: ChatMessageType;
      content: string;
      conversation_id: string;
      is_read?: boolean;
    },
    updatedConv: any,
    senderType: ChatSenderType,
    messageType: ChatMessageType,
    content: string,
  ) {
    const formattedConv = this.chatService.formatConversation(updatedConv);
    this.server.to('admin_inbox').emit('receiveMessage', { message: newMessage, conversation: formattedConv });
    this.server.to(`family_app_${familyId}`).emit('receiveMessage', { message: newMessage, conversation: formattedConv });

    if (senderType === 'ADMIN') {
      // Send FCM to parent only if they are NOT actively viewing the chat
      const parentInChat = this.isParentInChatRoom(familyId);
      if (!parentInChat) {
        await this.fcmService.sendToFamily(
          familyId,
          'New Message from TAFS',
          messageType === 'TEXT' ? content : `New ${messageType.toLowerCase()} received`,
          {
            type: 'CHAT_MESSAGE',
            conversationId: updatedConv.id.toString(),
            messageId: newMessage.id,
          },
        );
      } else {
        console.log(
          `[FCM] Chat push skipped for family ${familyId}: parent has chat screen open`,
        );
        // Parent already in thread → mark read now so sender ack / UI get blue ticks
        // without racing client markAsRead vs send confirmation.
        await this.chatService.markAsRead(familyId, 'GUARDIAN');
        this.broadcastMessagesRead(familyId, 'GUARDIAN');
        newMessage.is_read = true;
      }
    } else if (senderType === 'GUARDIAN' && this.isAdminViewingFamily(familyId)) {
      await this.chatService.markAsRead(familyId, 'ADMIN');
      this.broadcastMessagesRead(familyId, 'ADMIN');
      newMessage.is_read = true;
    }
  }

  /**
   * Checks whether the parent (family) is actively in the chat room
   * (i.e., has the chat screen open in Flutter via enterChat).
   *
   * Only parents ever join family_chat_* (see handleEnterChat), so room
   * membership alone is sufficient — no need to look up each socket's
   * payload. That lookup used to go through `server.sockets.sockets`,
   * which only contains sockets local to this process; `adapter.rooms`
   * is kept in sync across all instances by the redis adapter, so this
   * check is correct under a horizontally-scaled (multi-instance) deploy.
   */
  private isParentInChatRoom(familyId: number): boolean {
    const room = this.server.sockets.adapter.rooms.get(`family_chat_${familyId}`);
    return !!room && room.size > 0;
  }

  broadcastMessagesRead(familyId: number, by: 'ADMIN' | 'GUARDIAN') {
    if (by === 'ADMIN') {
      this.server.to(`family_app_${familyId}`).emit('messagesRead', { by: 'ADMIN' });
    } else {
      this.server.to('admin_inbox').emit('messagesRead', { familyId, by: 'GUARDIAN' });
      this.server.to(`family_app_${familyId}`).emit('messagesRead', { by: 'GUARDIAN' });
    }
  }

  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { familyId: any; senderType: ChatSenderType; messageType: ChatMessageType; content: string; mediaMetadata?: any; senderName?: string },
  ) {
    const familyId = Number(data.familyId);
    const payload = client.data.tafsPayload;

    console.log(
      `[ChatGateway] sendMessage family=${familyId} sender=${data.senderType} type=${data.messageType} from=${payload?.userType ?? 'unknown'}`,
    );

    // Parents must only send messages for their own family.
    if (payload?.userType === 'PARENT') {
      const authorizedFamilyId = Number(payload.familyId ?? payload.sub);
      if (authorizedFamilyId !== familyId) {
        return { error: 'forbidden' };
      }
    }

    // Resolve sender name: use provided name, or derive from JWT payload
    const senderName = data.senderName ||
      (payload?.userType === 'STAFF' ? (payload?.name || payload?.username || 'TAFS Admin') : undefined);

    const { newMessage, updatedConv, isDuplicate } = await this.chatService.createMessage(familyId, {
      senderType: data.senderType,
      messageType: data.messageType,
      content: data.content,
      mediaMetadata: data.mediaMetadata,
      senderName,
    });

    if (!isDuplicate) {
      await this.broadcastNewMessage(
        familyId,
        newMessage,
        updatedConv,
        data.senderType,
        data.messageType,
        data.content,
      );
    }

    return newMessage;
  }

  @SubscribeMessage('markAsRead')
  async handleMarkAsRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { familyId: any; role?: 'ADMIN' | 'GUARDIAN' },
  ) {
    const payload = client.data.tafsPayload;
    // Derive role from JWT — never trust the client-supplied role for tick semantics.
    const role: 'ADMIN' | 'GUARDIAN' =
      payload?.userType === 'STAFF'
        ? 'ADMIN'
        : payload?.userType === 'PARENT'
          ? 'GUARDIAN'
          : data.role === 'ADMIN' || data.role === 'GUARDIAN'
            ? data.role
            : 'GUARDIAN';

    const familyId = Number(data.familyId);
    if (payload?.userType === 'PARENT') {
      const authorizedFamilyId = Number(payload.familyId ?? payload.sub);
      if (authorizedFamilyId !== familyId) {
        return { error: 'forbidden' };
      }
    }

    const conv = await this.prisma.chat_conversations.findUnique({ where: { family_id: familyId } });
    if (!conv) return;

    await this.prisma.chat_conversations.update({
      where: { id: conv.id },
      data: {
        unread_by_admin: role === 'ADMIN' ? 0 : undefined,
        unread_by_parent: role === 'GUARDIAN' ? 0 : undefined,
        admin_last_read_at: role === 'ADMIN' ? new Date() : undefined,
        parent_last_read_at: role === 'GUARDIAN' ? new Date() : undefined,
      },
    });

    // Also mark all messages in this conversation as read
    await this.prisma.chat_messages.updateMany({
      where: {
        conversation_id: conv.id,
        sender_type: role === 'GUARDIAN' ? 'ADMIN' : 'GUARDIAN', // If Guardian marks as read, mark Admin's messages
        is_read: false
      },
      data: { is_read: true },
    });

    if (role === 'ADMIN') {
      this.server.to(`family_app_${familyId}`).emit('messagesRead', { by: 'ADMIN' });
    } else {
      this.server.to('admin_inbox').emit('messagesRead', { familyId: familyId, by: 'GUARDIAN' });
      // Also notify other devices of the same family
      this.server.to(`family_app_${familyId}`).emit('messagesRead', { by: 'GUARDIAN' });
    }
  }

  @SubscribeMessage('registerFcmToken')
  async handleRegisterFcmToken(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { familyId: any; token: string; deviceType?: string },
  ) {
    const familyId = Number(data.familyId);
    return this.fcmService.registerToken(familyId, data.token, data.deviceType);
  }

  /**
   * Server-side section/grade broadcast (roll call skipped, system events).
   * Same delivery as sendAnnouncement WS handler.
   */
  async publishAnnouncement(data: {
    content: string;
    targetGrade?: string;
    targetSection?: string;
    messageType?: ChatMessageType;
    mediaMetadata?: any;
  }) {
    return this.handleSendAnnouncement(null as any, {
      messageType: data.messageType ?? ChatMessageType.TEXT,
      content: data.content,
      targetGrade: data.targetGrade,
      targetSection: data.targetSection,
      mediaMetadata: data.mediaMetadata,
    });
  }

  /**
   * Per-family scoped announcement — used for roll call taken (per-student result).
   * Saves to the sentinel announcement conversation but delivers only to this family's socket room + FCM.
   */
  async publishFamilyAnnouncement(
    familyId: number,
    content: string,
    targetGrade?: string,
    targetSection?: string,
  ): Promise<void> {
    const ANNOUNCEMENT_CONV_ID = '00000000-0000-0000-0000-000000000000';

    const message = await this.prisma.chat_messages.create({
      data: {
        conversation_id: ANNOUNCEMENT_CONV_ID,
        sender_type: 'ADMIN',
        sender_name: 'TAFS Support',
        message_type: ChatMessageType.TEXT,
        content,
        is_announcement: true,
        target_grade: targetGrade ?? null,
        target_section: targetSection ?? null,
      },
    });

    const conversation = await this.prisma.chat_conversations.findUnique({
      where: { id: ANNOUNCEMENT_CONV_ID },
    });

    // Deliver only to the specific family room
    this.server.to(`family_app_${familyId}`).emit('receiveMessage', { message, conversation });
    this.server.to('admin_inbox').emit('receiveMessage', { message, conversation });

    // Background FCM push
    this.fcmService
      .sendToFamily(familyId, 'TAFS', content, { type: 'ANNOUNCEMENT', messageId: message.id })
      .catch((e) => console.error(`FCM failed for family ${familyId}:`, e.message));
  }

  private canSendAnnouncement(payload: {
    userType?: string;
    role?: string;
    permissions?: string[];
  }): boolean {
    if (payload?.userType !== 'STAFF') return false;
    if (payload.role === 'SUPER_ADMIN') return true;
    const perms = payload.permissions ?? [];
    return (
      perms.includes('communication.view_chats') ||
      perms.includes('communication.send_announcements')
    );
  }

  @SubscribeMessage('sendAnnouncement')
  async handleSendAnnouncement(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { 
      messageType: ChatMessageType; 
      content: string; 
      targetGrade?: string; 
      targetSection?: string;
      mediaMetadata?: any 
    },
  ) {
    const payload = client.data.tafsPayload;
    if (!this.canSendAnnouncement(payload)) {
      throw new WsException('Forbidden');
    }

    console.log('[ChatGateway] Received sendAnnouncement:', data);

    const ANNOUNCEMENT_CONV_ID = '00000000-0000-0000-0000-000000000000';

    // 1. Save to Database
    const announcement = await this.prisma.chat_messages.create({
      data: {
        conversation_id: ANNOUNCEMENT_CONV_ID,
        sender_type: 'ADMIN',
        sender_name: 'TAFS Support',
        message_type: data.messageType,
        content: data.content,
        media_metadata: data.mediaMetadata,
        is_announcement: true,
        target_grade: data.targetGrade || null,
        target_section: data.targetSection || null,
      },
    });

    const actor = auditActorLabel(payload ?? undefined);
    const target = data.targetSection
      ? `section ${data.targetSection}`
      : data.targetGrade
        ? `grade ${data.targetGrade}`
        : 'all parents';
    void this.auditLogs.log({
      entity_type: 'CHAT_MESSAGE',
      entity_id: announcement.id,
      action: 'CREATED',
      section: 'communication',
      new_value: (data.content ?? '').slice(0, 80),
      note: `Chat announcement (${target}) | Body: ${(data.content ?? '').slice(0, 120)}${(data.content?.length ?? 0) > 120 ? '…' : ''}`,
      changed_by: actor,
    });

    const conversation = await this.prisma.chat_conversations.findUnique({
      where: { id: ANNOUNCEMENT_CONV_ID }
    });

    // 2. Broadcast via Socket Rooms
    let targetRoom = 'all_parents';
    if (data.targetGrade && data.targetSection) {
      targetRoom = `section_${data.targetSection}`;
    } else if (data.targetGrade) {
      targetRoom = `grade_${data.targetGrade}`;
    }

    this.server.to(targetRoom).emit('receiveMessage', { message: announcement, conversation });
    
    // Also update Admin Inbox for reference
    this.server.to('admin_inbox').emit('receiveMessage', { message: announcement, conversation });

    // 3. Send Push Notifications (Background)
    const targetFamilies = await this.prisma.families.findMany({
      where: {
        students: {
          some: {
            deleted_at: null,
            classes: data.targetGrade ? { class_code: data.targetGrade } : undefined,
            sections: data.targetSection ? { description: data.targetSection } : undefined,
          }
        }
      },
      select: { id: true }
    });

    const familyIds = targetFamilies.map(f => f.id);
    
    for (const fId of familyIds) {
      this.fcmService.sendToFamily(
        fId,
        'TAFS Announcement',
        data.messageType === 'TEXT' ? data.content : `New official ${data.messageType.toLowerCase()} received`,
        { type: 'ANNOUNCEMENT', messageId: announcement.id }
      ).catch(e => console.error(`FCM failed for family ${fId}:`, e.message));
    }

    return announcement;
  }

  @SubscribeMessage('deleteMessage')
  async handleDeleteMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { messageId: string; familyId: any },
  ) {
    console.log('[ChatGateway] Received deleteMessage:', data);
    try {
      const familyId = Number(data.familyId);
      const existing = await this.prisma.chat_messages.findUnique({
        where: { id: data.messageId },
      });

      // 1. Delete from DB
      await this.prisma.chat_messages.delete({
        where: { id: data.messageId },
      });

      const actor = auditActorLabel(client?.data?.tafsPayload ?? undefined);
      void this.auditLogs.log({
        entity_type: 'CHAT_MESSAGE',
        entity_id: data.messageId,
        action: 'DELETED',
        section: 'communication',
        old_value: existing?.content?.slice(0, 80) ?? null,
        note: existing?.is_announcement
          ? `Deleted announcement | Body: ${(existing.content ?? '').slice(0, 120)}`
          : `Deleted chat message | Body: ${(existing?.content ?? '').slice(0, 120)}`,
        changed_by: actor,
      });

      // 2. Broadcast deletion
      this.server.to('admin_inbox').emit('messageDeleted', { messageId: data.messageId, familyId: familyId });
      this.server.to(`family_app_${familyId}`).emit('messageDeleted', { messageId: data.messageId });
      
      return { success: true };
    } catch (err) {
      console.error('[ChatGateway] Delete failed:', err);
      return { success: false, error: 'Delete failed' };
    }
  }

  // ─── Support Tickets ───────────────────────────────────────────────────────

  /**
   * True when the parent is actively viewing this support ticket (entered ticket room).
   *
   * Only parents join `parent_ticket_${ticketId}` (staff join the shared
   * `ticket_${ticketId}` room instead), and room membership is synced across
   * all instances by the redis adapter — so, like isParentInChatRoom, this is
   * correct under a multi-instance deploy without any local bookkeeping.
   */
  isParentInTicketRoom(ticketId: string): boolean {
    const room = this.server.sockets.adapter.rooms.get(`parent_ticket_${ticketId}`);
    return !!room && room.size > 0;
  }

  /**
   * True when any staff socket is actively viewing this ticket thread.
   * Uses fetchSockets so it works across redis-adapter instances (parents
   * also join `ticket_*`, so room size alone is not enough).
   */
  async isStaffInTicketRoom(ticketId: string): Promise<boolean> {
    try {
      const sockets = await this.server.in(`ticket_${ticketId}`).fetchSockets();
      return sockets.some((s) => s.data?.tafsPayload?.userType === 'STAFF');
    } catch {
      return false;
    }
  }

  @SubscribeMessage('enterTicket')
  async handleEnterTicket(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { ticketId: string },
  ) {
    const payload = client.data.tafsPayload;
    if (!payload) return { error: 'unauthorized' };
    try {
      await this.supportTicketsService.assertCanEnterTicketRoom(
        data.ticketId,
        payload,
      );
      client.join(`ticket_${data.ticketId}`);
      if (payload.userType === 'PARENT') {
        client.join(`parent_ticket_${data.ticketId}`);
      }
      return { success: true };
    } catch (err: any) {
      return { error: err.message ?? 'forbidden' };
    }
  }

  @SubscribeMessage('leaveTicket')
  handleLeaveTicket(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { ticketId: string },
  ) {
    const payload = client.data.tafsPayload;
    client.leave(`ticket_${data.ticketId}`);
    if (payload?.userType === 'PARENT') {
      client.leave(`parent_ticket_${data.ticketId}`);
    }
  }

  /**
   * Broadcast typing indicator to every relevant parent/staff spectator.
   * Fans out beyond `ticket_*` because parents may be in `family_app_*` /
   * `parent_ticket_*` without a successful ticket-room join — and typing must
   * still appear while they have the thread open.
   */
  @SubscribeMessage('ticketTyping')
  async handleTicketTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { ticketId?: string; ticket_id?: string; isTyping?: boolean },
  ) {
    const payload = client.data.tafsPayload;
    const ticketId = data?.ticketId ?? data?.ticket_id;
    if (!payload?.userType || !ticketId) return { error: 'unauthorized' };

    const typingPayload = {
      ticketId,
      isTyping: !!data?.isTyping,
      userType: payload.userType as 'STAFF' | 'PARENT',
      userId: payload.sub != null ? String(payload.sub) : undefined,
      role: payload.role as string | undefined,
    };

    // Exclude sender; deliver everywhere a parent/staff might be listening.
    client.to(`ticket_${ticketId}`).emit('ticketTyping', typingPayload);
    client.to(`parent_ticket_${ticketId}`).emit('ticketTyping', typingPayload);

    try {
      const ticket = await this.prisma.support_tickets.findUnique({
        where: { id: ticketId },
        select: { family_id: true },
      });
      if (ticket?.family_id != null) {
        client
          .to(`family_app_${ticket.family_id}`)
          .emit('ticketTyping', typingPayload);
      }
    } catch (err: any) {
      console.warn('[ChatGateway] ticketTyping family fan-out failed:', err?.message);
    }

    return { success: true };
  }

  @SubscribeMessage('sendTicketMessage')
  async handleSendTicketMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      ticketId: string;
      messageType: ChatMessageType;
      content: string;
      mediaMetadata?: Record<string, unknown>;
    },
  ) {
    const payload = client.data.tafsPayload;
    if (!payload) return { error: 'unauthorized' };

    try {
      return await this.supportTicketsService.sendTicketMessageFromSocket(
        data.ticketId,
        payload,
        {
          messageType: data.messageType,
          content: data.content,
          mediaMetadata: data.mediaMetadata,
        },
      );
    } catch (err: any) {
      return { error: err.message ?? 'failed' };
    }
  }

  @SubscribeMessage('deleteTicketMessage')
  async handleDeleteTicketMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { messageId: string },
  ) {
    const payload = client.data.tafsPayload;
    if (!payload || payload.userType !== 'STAFF') {
      return { error: 'unauthorized' };
    }
    if (!data?.messageId) return { error: 'messageId required' };

    try {
      return await this.supportTicketsService.deleteOwnStaffMessage(
        data.messageId,
        payload,
      );
    } catch (err: any) {
      return { error: err.message ?? 'failed' };
    }
  }

  async broadcastTicketCreated(ticket: any) {
    this.server.to('super_admin_approvals').emit('ticketCreated', { ticket });
    if (ticket.current_assignee_id) {
      this.server
        .to(`staff_inbox_${ticket.current_assignee_id}`)
        .emit('ticketCreated', { ticket });
    }
    if (ticket.routed_role === 'FINANCE_CLERK') {
      this.server.to('finance_queue').emit('ticketCreated', { ticket });
    }
    if (ticket.routed_role === 'GENERAL_RESPONDENT') {
      this.server.to('general_respondent_inbox').emit('ticketCreated', { ticket });
    }
  }

  async broadcastTicketClaimed(ticket: any) {
    this.server.to('finance_queue').emit('ticketClaimed', { ticket });
    if (ticket.current_assignee_id) {
      this.server
        .to(`staff_inbox_${ticket.current_assignee_id}`)
        .emit('ticketClaimed', { ticket });
    }
  }

  async broadcastTicketTransferred(ticket: any, fromUserId: string, toUserId: string) {
    this.server.to(`staff_inbox_${fromUserId}`).emit('ticketTransferred', { ticket, toUserId });
    this.server.to(`staff_inbox_${toUserId}`).emit('ticketTransferred', { ticket, fromUserId });
    this.server.to('finance_queue').emit('ticketTransferred', { ticket });
  }

  async broadcastTicketForwarded(ticket: any, fromUserId: string, toUserId: string) {
    this.server.to(`staff_inbox_${fromUserId}`).emit('ticketForwarded', { ticket, toUserId });
    this.server.to(`staff_inbox_${toUserId}`).emit('ticketForwarded', { ticket, fromUserId });
  }

  async broadcastReplyPendingApproval(message: any, ticket: any) {
    const payload = { message, ticket, status: 'PENDING' as const };
    this.server.to('super_admin_approvals').emit('replyPendingApproval', payload);
    if (ticket.current_assignee_id) {
      this.server
        .to(`staff_inbox_${ticket.current_assignee_id}`)
        .emit('replyPendingApproval', payload);
    }
    this.emitToTicketRoom(ticket.id, 'replyPendingApproval', payload);
  }

  broadcastVoucherAlert(
    familyId: number,
    payload: {
      id: number;
      voucher_id: number;
      student_cc: number;
      alert_type: string;
      title: string;
      body: string;
      created_at: Date;
    },
  ) {
    this.server.to(`family_app_${familyId}`).emit('voucherAlertReceived', payload);
  }

  broadcastNoticeBoard(
    familyId: number,
    payload: {
      type: 'notice_board';
      post_id: number;
      title: string;
      body: string;
      is_pinned: boolean;
    },
  ) {
    this.server.to(`family_app_${familyId}`).emit('noticeBoardReceived', payload);
  }

  broadcastAttendanceAlert(
    familyId: number,
    payload: {
      id: number;
      student_cc: number;
      direction: string;
      scan_time: string;
      title: string;
      body: string;
      created_at: Date | string;
    },
  ) {
    this.server.to(`family_app_${familyId}`).emit('attendanceAlertReceived', payload);
  }

  /**
   * Fan-out read receipts for support tickets.
   * by=PARENT → staff's approved messages were read (blue ticks on staff UI)
   * by=STAFF  → parent's messages were read (blue ticks on parent app)
   */
  broadcastTicketMessagesRead(
    ticketId: string,
    familyId: number,
    by: 'PARENT' | 'STAFF',
    assigneeId?: string | null,
  ) {
    const payload = { ticketId, by };
    this.server.to(`family_app_${familyId}`).emit('ticketMessagesRead', payload);
    this.emitToTicketRoom(ticketId, 'ticketMessagesRead', payload);
    if (assigneeId) {
      this.server.to(`staff_inbox_${assigneeId}`).emit('ticketMessagesRead', payload);
    }
    this.server.to('super_admin_approvals').emit('ticketMessagesRead', payload);
  }

  async broadcastApprovedTicketMessage(ticket: any, message: any) {
    // Always include ticket_id on the message — some Prisma shapes omit it when
    // nested under includes, and Flutter filters live events by ticketId.
    const normalizedMessage = {
      ...message,
      ticket_id: message?.ticket_id ?? message?.ticketId ?? ticket?.id,
    };
    const messagePayload = { ticket, message: normalizedMessage };
    this.server
      .to(`family_app_${ticket.family_id}`)
      .emit('ticketMessageReceived', messagePayload);
    if (ticket.current_assignee_id) {
      this.server
        .to(`staff_inbox_${ticket.current_assignee_id}`)
        .emit('ticketMessageReceived', messagePayload);
    }
    // Super admins watching from oversight may not be the assignee — ensure they
    // still receive realtime delivery when in the ticket room (and via approvals).
    this.server.to('super_admin_approvals').emit('ticketMessageReceived', messagePayload);
    this.emitToTicketRoom(ticket.id, 'ticketMessageReceived', messagePayload);
    const reviewedPayload = {
      ticket,
      message: normalizedMessage,
      status: 'APPROVED' as const,
    };
    this.server.to('super_admin_approvals').emit('replyReviewed', reviewedPayload);
    this.emitToTicketRoom(ticket.id, 'replyReviewed', reviewedPayload);
  }

  async broadcastReplyRejected(
    ticketId: string,
    responderId: string,
    comment: string | undefined,
    message: any,
  ) {
    const payload = {
      ticketId,
      message,
      status: 'REJECTED' as const,
      reviewComment: comment,
    };
    this.server.to(`staff_inbox_${responderId}`).emit('replyReviewed', payload);
    this.server.to('super_admin_approvals').emit('replyReviewed', payload);
    this.emitToTicketRoom(ticketId, 'replyReviewed', payload);
  }

  async broadcastTicketMessageToStaff(ticket: any, message: any) {
    const normalizedMessage = {
      ...message,
      ticket_id: message?.ticket_id ?? message?.ticketId ?? ticket?.id,
    };
    const payload = { ticket, message: normalizedMessage };
    if (ticket.current_assignee_id) {
      this.server
        .to(`staff_inbox_${ticket.current_assignee_id}`)
        .emit('ticketMessageReceived', payload);
    }
    if (ticket.routed_role === 'FINANCE_CLERK' && !ticket.current_assignee_id) {
      this.server.to('finance_queue').emit('ticketMessageReceived', payload);
    }
    this.server.to('super_admin_approvals').emit('ticketMessageReceived', payload);
    this.emitToTicketRoom(ticket.id, 'ticketMessageReceived', payload);
  }

  async broadcastTicketClosed(ticket: any) {
    this.server
      .to(`family_app_${ticket.family_id}`)
      .emit('ticketClosed', { ticket });
    if (ticket.current_assignee_id) {
      this.server
        .to(`staff_inbox_${ticket.current_assignee_id}`)
        .emit('ticketClosed', { ticket });
    }
    this.server.to('super_admin_approvals').emit('ticketClosed', { ticket });
    this.emitToTicketRoom(ticket.id, 'ticketClosed', { ticket });
  }

  async broadcastTicketMessageDeleted(
    ticket: any,
    messageId: string,
    message?: unknown,
  ) {
    const payload = {
      ticketId: ticket.id,
      messageId,
      ticket,
      ...(message ? { message } : {}),
    };
    this.server
      .to(`family_app_${ticket.family_id}`)
      .emit('ticketMessageDeleted', payload);
    if (ticket.current_assignee_id) {
      this.server
        .to(`staff_inbox_${ticket.current_assignee_id}`)
        .emit('ticketMessageDeleted', payload);
    }
    if (ticket.routed_role === 'FINANCE_CLERK' && !ticket.current_assignee_id) {
      this.server.to('finance_queue').emit('ticketMessageDeleted', payload);
    }
    this.server.to('super_admin_approvals').emit('ticketMessageDeleted', payload);
    this.emitToTicketRoom(ticket.id, 'ticketMessageDeleted', payload);
  }

  private emitToTicketRoom(ticketId: string | null | undefined, event: string, payload: unknown) {
    if (!ticketId) return;
    this.server.to(`ticket_${ticketId}`).emit(event, payload);
  }
}
