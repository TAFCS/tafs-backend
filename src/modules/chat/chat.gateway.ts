import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChatSenderType, ChatMessageType } from '@prisma/client';
import { FcmService } from '../../common/fcm/fcm.service';

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
  
  // Track online families: Map<familyId, Set<socketId>>
  private familySockets = new Map<number, Set<string>>();
  // Reverse lookup: Map<socketId, familyId>
  private socketToFamily = new Map<string, number>();

  // Track which admin sockets are actively viewing which family chat
  // Map<familyId, Set<socketId>> — for FCM suppression when admin is viewing
  private adminViewingFamily = new Map<number, Set<string>>();
  // Reverse: Map<socketId, familyId> — so we can clean up on disconnect
  private socketAdminViewing = new Map<string, number>();

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly fcmService: FcmService,
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
          (socket as any).tafsPayload = payload;
          return next();
        }

        const payload = this.jwtService.verify(rawToken);
        (socket as any).tafsPayload = payload;
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
    const payload = (client as any).tafsPayload;
    console.log('[ChatGateway] Connected:', payload.userType, payload.sub || payload.familyId);
    try {
      if (payload.userType === 'STAFF') {
        client.join('admin_inbox');
        console.log(`[ChatGateway] Staff joined admin_inbox: ${client.id}`);
      } else if (payload.userType === 'PARENT') {
        const familyId = Number(payload.familyId || payload.sub);
        if (isNaN(familyId)) {
          client.disconnect(true);
          return;
        }
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

        // Track presence
        if (!this.familySockets.has(familyId)) {
          this.familySockets.set(familyId, new Set());
        }
        this.familySockets.get(familyId)!.add(client.id);
        this.socketToFamily.set(client.id, familyId);

        // Notify admins that this family is online
        this.server
          .to('admin_inbox')
          .emit('userStatusChanged', { familyId, status: 'ONLINE' });
        console.log(`[ChatGateway] Parent ${familyId} connected: ${client.id}`);
      }
    } catch (error: any) {
      console.warn('[ChatGateway] Room setup error:', error.message);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    console.log('[ChatGateway] Client disconnected:', client.id);
    
    // Clean up parent presence
    const familyId = this.socketToFamily.get(client.id);
    if (familyId) {
      this.socketToFamily.delete(client.id);
      const sockets = this.familySockets.get(familyId);
      if (sockets) {
        sockets.delete(client.id);
        if (sockets.size === 0) {
          this.familySockets.delete(familyId);
          // Only notify offline if NO other sockets are connected for this family
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
  }

  @SubscribeMessage('getOnlineStatus')
  handleGetOnlineStatus(@ConnectedSocket() client: Socket) {
    const onlineIds = Array.from(this.familySockets.keys());
    return { onlineFamilyIds: onlineIds };
  }

  @SubscribeMessage('enterChat')
  handleEnterChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { familyId: any },
  ) {
    const familyId = Number(data.familyId);
    // Join the family-specific chat room (used for FCM suppression)
    client.join(`family_chat_${familyId}`);

    // Track admin viewing for FCM suppression
    const payload = (client as any).tafsPayload;
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
    client.leave(`family_chat_${familyId}`);

    // Clean up admin viewing tracking
    const payload = (client as any).tafsPayload;
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
    newMessage: { id: string; message_type: ChatMessageType; content: string; conversation_id: string },
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
      }
    }
  }

  /**
   * Checks whether the parent (family) is actively in the chat room
   * (i.e., has the chat screen open in Flutter via enterChat).
   */
  private isParentInChatRoom(familyId: number): boolean {
    const roomName = `family_chat_${familyId}`;
    const room = this.server.sockets.adapter.rooms.get(roomName);
    return room !== undefined && room.size > 0;
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
    const payload = (client as any).tafsPayload;

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
    @MessageBody() data: { familyId: any; role: 'ADMIN' | 'GUARDIAN' },
  ) {
    const familyId = Number(data.familyId);
    const conv = await this.prisma.chat_conversations.findUnique({ where: { family_id: familyId } });
    if (!conv) return;

    await this.prisma.chat_conversations.update({
      where: { id: conv.id },
      data: {
        unread_by_admin: data.role === 'ADMIN' ? 0 : undefined,
        unread_by_parent: data.role === 'GUARDIAN' ? 0 : undefined,
        admin_last_read_at: data.role === 'ADMIN' ? new Date() : undefined,
        parent_last_read_at: data.role === 'GUARDIAN' ? new Date() : undefined,
      },
    });

    // Also mark all messages in this conversation as read
    await this.prisma.chat_messages.updateMany({
      where: { 
        conversation_id: conv.id,
        sender_type: data.role === 'GUARDIAN' ? 'ADMIN' : 'GUARDIAN', // If Guardian marks as read, mark Admin's messages
        is_read: false 
      },
      data: { is_read: true },
    });

    if (data.role === 'ADMIN') {
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
      // 1. Delete from DB
      await this.prisma.chat_messages.delete({
        where: { id: data.messageId },
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
}
