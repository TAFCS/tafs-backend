import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { ChatSenderType, ChatMessageType } from '@prisma/client';
import * as path from 'path';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async getAdminInbox() {
    const conversations = await this.prisma.chat_conversations.findMany({
      where: {
        id: { not: '00000000-0000-0000-0000-000000000000' }
      },
      orderBy: { last_message_at: 'desc' },
      include: {
        families: {
          select: { 
            id: true, 
            household_name: true, 
            legacy_pid: true, 
            email: true, 
            home_phone: true,
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
          },
        },
      },
    });

    return conversations.map(c => this.formatConversation(c));
  }

  formatConversation(c: any) {
    // Find primary guardian across all students
    let primaryGuardian: any = null;
    if (c.families?.students) {
      for (const student of c.families.students) {
        // 1. Try to find primary contact
        let pg = student.student_guardians.find(sg => sg.is_primary_contact);
        
        // 2. Fallback to Father if no primary contact found yet
        if (!pg) {
          pg = student.student_guardians.find(sg => 
            sg.relationship?.toString().toUpperCase() === 'FATHER' || 
            sg.relationship?.toString().toUpperCase() === 'PAPA'
          );
        }

        if (pg) {
          primaryGuardian = pg.guardians;
          break;
        }
      }
      
      // 3. Last resort fallback to first guardian of first student
      if (!primaryGuardian && c.families.students[0]?.student_guardians[0]) {
        primaryGuardian = c.families.students[0].student_guardians[0].guardians;
      }
    }

    const { families, ...rest } = c;
    
    // Aggressive photo discovery
    let bestPhoto = primaryGuardian?.photo_url;
    if (!bestPhoto) bestPhoto = primaryGuardian?.cnic_pic_url;
    
    // Fallback to student photo if guardian has none
    if (!bestPhoto && families?.students) {
      const studentWithPhoto = families.students.find((s: any) => s.photograph_url);
      if (studentWithPhoto) {
        bestPhoto = studentWithPhoto.photograph_url;
      }
    }

    // Last resort: passport photo
    if (!bestPhoto) bestPhoto = primaryGuardian?.passport_front_url;

    return {
      ...rest,
      families,
      primary_guardian: {
        name: primaryGuardian?.full_name || families?.household_name || "Family Chat",
        photo_url: bestPhoto || null
      }
    };
  }

  async getFamilyStudents(familyId: number) {
    return this.prisma.students.findMany({
      where: { family_id: familyId, deleted_at: null },
      select: {
        cc: true,
        full_name: true,
        photograph_url: true,
        gr_number: true,
        primary_phone: true,
        whatsapp_number: true,
        whatsapp_country_code: true,
        classes: { select: { description: true, class_code: true } },
        sections: { select: { description: true } },
        campuses: { select: { campus_name: true } }
      }
    });
  }

  async getParentStudents(familyId: number) {
    return this.getFamilyStudents(familyId);
  }

  async getChatHistory(familyId: number, take: number = 50, skip: number = 0) {
    if (familyId === 0) {
      // Fetch Global Announcements
      const ANNOUNCEMENT_CONV_ID = '00000000-0000-0000-0000-000000000000';
      return this.prisma.chat_messages.findMany({
        where: { conversation_id: ANNOUNCEMENT_CONV_ID },
        orderBy: { created_at: 'desc' },
        take,
        skip,
      });
    }

    const conversation = await this.prisma.chat_conversations.findUnique({
      where: { family_id: familyId },
    });

    if (!conversation) {
      return [];
    }

    // Fetch students of this family to know which announcements to show
    const students = await this.prisma.students.findMany({
      where: { family_id: familyId, deleted_at: null },
      select: { class_id: true, section_id: true, classes: { select: { class_code: true } }, sections: { select: { description: true } } }
    });

    const gradeCodes = students.map(s => s.classes?.class_code).filter(Boolean);
    const sectionNames = students.map(s => s.sections?.description).filter(Boolean);

    const messages = await this.prisma.chat_messages.findMany({
      where: {
        OR: [
          { conversation_id: conversation.id },
          {
            is_announcement: true,
            OR: [
              { target_grade: null },
              { target_grade: { in: gradeCodes as string[] } }
            ],
            AND: [
              {
                OR: [
                  { target_section: null },
                  { target_section: { in: sectionNames as string[] } }
                ]
              }
            ]
          }
        ]
      },
      orderBy: { created_at: 'desc' },
      take,
      skip,
    });

    // Map messages to include accurate is_read status based on last_read_at of the recipient
    const parentLastRead = conversation.parent_last_read_at;
    const adminLastRead = conversation.admin_last_read_at;
    return messages.map(m => {
      const isReadByRecipient = m.sender_type === 'ADMIN'
        ? (m.is_read || (parentLastRead && m.created_at <= parentLastRead))
        : (m.is_read || (adminLastRead && m.created_at <= adminLastRead));
      return {
        ...m,
        is_read: isReadByRecipient,
      };
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

  async acknowledgeMessage(messageId: string, familyId: number) {
    await this.prisma.message_acknowledgments.upsert({
      where: { message_id_family_id: { message_id: messageId, family_id: familyId } },
      create: { message_id: messageId, family_id: familyId },
      update: {},
    });
    return { acknowledged: true };
  }

  async getAcknowledgments(messageId: string) {
    const acks = await this.prisma.message_acknowledgments.findMany({
      where: { message_id: messageId },
      include: {
        families: { select: { id: true, household_name: true } },
      },
      orderBy: { acknowledged_at: 'asc' },
    });
    return acks;
  }

  async getOrCreateConversation(familyId: number) {
    let conversation = await this.prisma.chat_conversations.findUnique({
      where: { family_id: familyId },
    });

    if (!conversation) {
      conversation = await this.prisma.chat_conversations.create({
        data: { family_id: familyId },
      });
      await this.auditLogs.log({
        entity_type: 'CHAT_CONVERSATION',
        entity_id: conversation.id,
        action: 'CREATED',
        changed_by: 'system',
        note: `Chat conversation created for family #${familyId}.`,
      });
    }

    return conversation;
  }

  private conversationInclude = {
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
                    passport_front_url: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  async findMessageByTempId(
    familyId: number,
    tempId: string,
    senderType: ChatSenderType = 'GUARDIAN',
  ) {
    const conv = await this.prisma.chat_conversations.findUnique({
      where: { family_id: familyId },
    });
    if (!conv) return null;

    const recent = await this.prisma.chat_messages.findMany({
      where: {
        conversation_id: conv.id,
        sender_type: senderType,
      },
      orderBy: { created_at: 'desc' },
      take: 100,
    });

    return (
      recent.find((m) => {
        const meta = m.media_metadata as Record<string, unknown> | null;
        return meta?.tempId === tempId;
      }) ?? null
    );
  }

  async createMessage(
    familyId: number,
    data: {
      senderType: ChatSenderType;
      messageType: ChatMessageType;
      content: string;
      mediaMetadata?: Record<string, unknown>;
      senderName?: string;
    },
  ) {
    const tempId = data.mediaMetadata?.tempId as string | undefined;
    if (tempId) {
      const existing = await this.findMessageByTempId(familyId, tempId, data.senderType);
      if (existing) {
        const conv = await this.prisma.chat_conversations.findUnique({
          where: { family_id: familyId },
          include: this.conversationInclude,
        });
        return { newMessage: existing, updatedConv: conv!, isDuplicate: true };
      }
    }

    const conv = await this.getOrCreateConversation(familyId);

    const snippet =
      data.messageType === 'TEXT'
        ? data.content.substring(0, 50)
        : `[${data.messageType}]`;

    const [newMessage, updatedConv] = await this.prisma.$transaction([
      this.prisma.chat_messages.create({
        data: {
          conversation_id: conv.id,
          sender_type: data.senderType,
          sender_name: data.senderName ?? null,
          message_type: data.messageType,
          content: data.content,
          media_metadata: (data.mediaMetadata ?? undefined) as object | undefined,
        },
      }),
      this.prisma.chat_conversations.update({
        where: { id: conv.id },
        data: {
          last_message_at: new Date(),
          last_message_snippet: snippet,
          unread_by_admin:
            data.senderType === 'GUARDIAN' ? { increment: 1 } : undefined,
          unread_by_parent:
            data.senderType === 'ADMIN' ? { increment: 1 } : undefined,
        },
        include: this.conversationInclude,
      }),
    ]);

    await this.auditLogs.log({
      entity_type: 'CHAT_MESSAGE',
      entity_id: newMessage.id,
      action: 'CREATED',
      changed_by: data.senderName || data.senderType,
      note: `Chat message created in conversation ${conv.id} (family #${familyId}) by ${data.senderType}: "${snippet}".`,
    });

    return { newMessage, updatedConv, isDuplicate: false };
  }

  async markAsRead(familyId: number, role: 'ADMIN' | 'GUARDIAN') {
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
  }
}
