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
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

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
        const familyId = payload.familyId || payload.sub;
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
  }

  @SubscribeMessage('enterChat')
  handleEnterChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { familyId: number },
  ) {
    client.join(`family_chat_${data.familyId}`);
    console.log(`[ChatGateway] Socket ${client.id} entered chat for family ${data.familyId}`);
  }

  @SubscribeMessage('leaveChat')
  handleLeaveChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { familyId: number },
  ) {
    client.leave(`family_chat_${data.familyId}`);
    console.log(`[ChatGateway] Socket ${client.id} left chat for family ${data.familyId}`);
  }

  private extractTokenFromCookie(cookieString?: string): string | null {
    if (!cookieString) return null;
    const match = cookieString.match(/(?:^|;)\s*tafs_access=([^;]+)/);
    return match ? match[1] : null;
  }

  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { familyId: number; senderType: ChatSenderType; messageType: ChatMessageType; content: string; mediaMetadata?: any },
  ) {
    console.log('[ChatGateway] Received sendMessage:', data);
    // 1. Ensure conversation exists
    const conv = await this.chatService.getOrCreateConversation(data.familyId);

    // 2. Save Message via Prisma Transaction
    const [newMessage, updatedConv] = await this.prisma.$transaction([
      this.prisma.chat_messages.create({
        data: {
          conversation_id: conv.id,
          sender_type: data.senderType,
          message_type: data.messageType,
          content: data.content,
          media_metadata: data.mediaMetadata,
        },
      }),
      this.prisma.chat_conversations.update({
        where: { id: conv.id },
        data: {
          last_message_at: new Date(),
          last_message_snippet: data.messageType === 'TEXT' ? data.content.substring(0, 50) : `[${data.messageType}]`,
          unread_by_admin: data.senderType === 'GUARDIAN' ? { increment: 1 } : undefined,
          unread_by_parent: data.senderType === 'ADMIN' ? { increment: 1 } : undefined,
        },
        include: {
          families: {
            include: {
              students: {
                where: { deleted_at: null },
                include: {
                  student_guardians: {
                    select: {
                      is_primary_contact: true,
                      relationship: true,
                      guardians: { 
                        select: { 
                          full_name: true, 
                          photo_url: true,
                          cnic_pic_url: true,
                          passport_front_url: true
                        } 
                      } 
                    }
                  }
                }
              }
            }
          }
        }
      }),
    ]);

    // 3. Broadcast to Admin Inbox and Family Room
    const formattedConv = this.chatService.formatConversation(updatedConv);
    this.server.to('admin_inbox').emit('receiveMessage', { message: newMessage, conversation: formattedConv });
    
    // Always broadcast to the global "app" room so the app gets the data even if not on chat screen
    this.server.to(`family_app_${data.familyId}`).emit('receiveMessage', { message: newMessage, conversation: formattedConv });

    // 4. Send Push Notification to Family if sender is ADMIN
    if (data.senderType === 'ADMIN') {
      const roomName = `family_chat_${data.familyId}`;
      const room = this.server.sockets.adapter.rooms.get(roomName);
      const isViewingChat = room && room.size > 0;
      
      console.log(`[ChatGateway] Presence Check for Family ${data.familyId}:`, {
        roomName,
        activeViewers: room?.size || 0,
        isViewingChat
      });

      if (!isViewingChat) {
        console.log(`[ChatGateway] User not in chat room. Attempting push notification...`);
        await this.fcmService.sendToFamily(
          data.familyId,
          'New Message from TAFS',
          data.messageType === 'TEXT' ? data.content : `New ${data.messageType.toLowerCase()} received`,
          { 
            type: 'CHAT_MESSAGE', 
            conversationId: conv.id.toString(),
            messageId: newMessage.id
          }
        );
      } else {
        console.log(`[ChatGateway] User is actively viewing chat. Skipping push notification.`);
      }
    }
    
    return newMessage;
  }

  @SubscribeMessage('markAsRead')
  async handleMarkAsRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { familyId: number; role: 'ADMIN' | 'GUARDIAN' },
  ) {
    const conv = await this.prisma.chat_conversations.findUnique({ where: { family_id: data.familyId } });
    if (!conv) return;

    await this.prisma.chat_conversations.update({
      where: { id: conv.id },
      data: {
        unread_by_admin: data.role === 'ADMIN' ? 0 : undefined,
        unread_by_parent: data.role === 'GUARDIAN' ? 0 : undefined,
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
      this.server.to(`family_app_${data.familyId}`).emit('messagesRead', { by: 'ADMIN' });
    } else {
      this.server.to('admin_inbox').emit('messagesRead', { familyId: data.familyId, by: 'GUARDIAN' });
    }
  }

  @SubscribeMessage('registerFcmToken')
  async handleRegisterFcmToken(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { familyId: number; token: string; deviceType?: string },
  ) {
    return this.fcmService.registerToken(data.familyId, data.token, data.deviceType);
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
    @MessageBody() data: { messageId: string; familyId: number },
  ) {
    console.log('[ChatGateway] Received deleteMessage:', data);
    try {
      // 1. Delete from DB
      await this.prisma.chat_messages.delete({
        where: { id: data.messageId },
      });

      // 2. Broadcast deletion
      this.server.to('admin_inbox').emit('messageDeleted', { messageId: data.messageId, familyId: data.familyId });
      this.server.to(`family_app_${data.familyId}`).emit('messageDeleted', { messageId: data.messageId });
      
      return { success: true };
    } catch (err) {
      console.error('[ChatGateway] Delete failed:', err);
      return { success: false, error: 'Delete failed' };
    }
  }
}
