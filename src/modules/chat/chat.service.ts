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
        classes: { select: { description: true, class_code: true } },
        sections: { select: { description: true } },
        campuses: { select: { campus_name: true } }
      }
    });
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

    return this.prisma.chat_messages.findMany({
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
