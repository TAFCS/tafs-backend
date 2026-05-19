import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ChatService } from './chat.service';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChatSenderType, ChatMessageType } from '@prisma/client';
import { FcmService } from './fcm.service';

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;
  
  // Track online families: Map<familyId, Set<socketId>>
  private familySockets = new Map<number, Set<string>>();
  // Reverse lookup: Map<socketId, familyId>
  private socketToFamily = new Map<string, number>();

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly fcmService: FcmService,
  ) {}

  async handleConnection(client: Socket) {
    console.log('[ChatGateway] Connection attempt from:', client.id);
    try {
      // 1. Extract Token from handshake auth or headers
      const token = client.handshake.auth?.token || client.handshake.headers?.authorization?.split(' ')[1];
      
      let payload: any;
      if (!token) {
        // Allow fallback to cookies for Staff Next.js client
        const cookieToken = this.extractTokenFromCookie(client.handshake.headers.cookie);
        if (!cookieToken) {
          console.warn('[ChatGateway] No token found for client:', client.id);
          throw new Error('No token provided');
        }
        
        payload = this.jwtService.verify(cookieToken);
      } else {
        payload = this.jwtService.verify(token);
      }

      console.log('[ChatGateway] Token verified for:', payload.userType, payload.sub || payload.id);

      if (payload.userType === 'STAFF') {
        client.join('admin_inbox');
        console.log(`[ChatGateway] Staff connected to admin_inbox: ${client.id}`);
      } else if (payload.userType === 'PARENT') {
        const familyId = Number(payload.familyId || payload.sub);
        if (isNaN(familyId)) {
          throw new Error('Invalid familyId');
        }
        client.join(`family_app_${familyId}`);
        client.join('all_parents');
        
        // Join Grade and Section rooms for announcements
        const students = await this.prisma.students.findMany({
          where: { family_id: familyId, deleted_at: null },
          include: { classes: true, sections: true }
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
        this.server.to('admin_inbox').emit('userStatusChanged', { familyId, status: 'ONLINE' });
        
        console.log(`[ChatGateway] Parent ${familyId} connected and joined announcement rooms: ${client.id}`);
      } else {
        throw new Error('Unknown user type');
      }
    } catch (error) {
      console.error('[ChatGateway] Connection rejected:', error.message);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    console.log('[ChatGateway] Client disconnected:', client.id);
    
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
    client.join(`family_chat_${familyId}`);
    console.log(`[ChatGateway] Socket ${client.id} entered chat for family ${familyId}`);
  }

  @SubscribeMessage('leaveChat')
  handleLeaveChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { familyId: any },
  ) {
    const familyId = Number(data.familyId);
    client.leave(`family_chat_${familyId}`);
    console.log(`[ChatGateway] Socket ${client.id} left chat for family ${familyId}`);
  }

  private extractTokenFromCookie(cookieString?: string): string | null {
    if (!cookieString) return null;
    const match = cookieString.match(/(?:^|;)\s*tafs_access=([^;]+)/);
    return match ? match[1] : null;
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
      const roomName = `family_chat_${familyId}`;
      const room = this.server.sockets.adapter.rooms.get(roomName);
      const isViewingChat = room && room.size > 0;

      if (!isViewingChat) {
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

  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { familyId: any; senderType: ChatSenderType; messageType: ChatMessageType; content: string; mediaMetadata?: any },
  ) {
    const familyId = Number(data.familyId);
    const { newMessage, updatedConv, isDuplicate } = await this.chatService.createMessage(familyId, {
      senderType: data.senderType,
      messageType: data.messageType,
      content: data.content,
      mediaMetadata: data.mediaMetadata,
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
