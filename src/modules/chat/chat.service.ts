import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import * as path from 'path';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async getAdminInbox() {
    return this.prisma.chat_conversations.findMany({
      orderBy: { last_message_at: 'desc' },
      include: {
        families: {
          select: { id: true, household_name: true, legacy_pid: true, email: true, home_phone: true },
        },
      },
    });
  }

  async getChatHistory(familyId: number, take: number = 50, skip: number = 0) {
    const conversation = await this.prisma.chat_conversations.findUnique({
      where: { family_id: familyId },
    });

    if (!conversation) {
      return [];
    }

    return this.prisma.chat_messages.findMany({
      where: { conversation_id: conversation.id },
      orderBy: { created_at: 'desc' },
      take,
      skip,
    });
  }

  async uploadMedia(file: Express.Multer.File): Promise<{ url: string, metadata: any }> {
    if (!file) throw new BadRequestException('No file provided');
    
    // Determine target folder based on mime type
    let folder = 'chat/misc';
    if (file.mimetype.startsWith('image/')) folder = 'chat/images';
    else if (file.mimetype.startsWith('audio/')) folder = 'chat/voice';
    else if (file.mimetype === 'application/pdf') folder = 'chat/docs';

    const timestamp = new Date().getTime();
    const ext = path.extname(file.originalname);
    const key = `${folder}/${new Date().getFullYear()}/${new Date().getMonth() + 1}/${timestamp}${ext}`;

    const url = await this.storage.upload(key, file.buffer, file.mimetype);

    const metadata = {
      sizeBytes: file.size,
      mimetype: file.mimetype,
      originalName: file.originalname
    };

    return { url, metadata };
  }

  async getMediaFile(key: string) {
    return this.storage.getFile(key);
  }

  async getOrCreateConversation(familyId: number) {
    let conversation = await this.prisma.chat_conversations.findUnique({
      where: { family_id: familyId },
    });

    if (!conversation) {
      conversation = await this.prisma.chat_conversations.create({
        data: { family_id: familyId },
      });
    }

    return conversation;
  }
}
