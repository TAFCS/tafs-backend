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
    origin: ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001'],
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
        console.log(`[ChatGateway] Parent ${familyId} connected to global room: ${client.id}`);
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
        include: { families: { select: { household_name: true } } }
      }),
    ]);

    // 3. Broadcast to Admin Inbox and Family Room
    this.server.to('admin_inbox').emit('receiveMessage', { message: newMessage, conversation: updatedConv });
    
    // Always broadcast to the global "app" room so the app gets the data even if not on chat screen
    this.server.to(`family_app_${data.familyId}`).emit('receiveMessage', { message: newMessage, conversation: updatedConv });

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
