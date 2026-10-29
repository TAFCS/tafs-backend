import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ChatService } from './chat.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ScopeService } from '../../common/scope/scope.service';

describe('ChatService', () => {
  let service: ChatService;
  let prisma: {
    chat_messages: { findMany: jest.Mock };
    ticket_messages: { findMany: jest.Mock };
    families: { count: jest.Mock };
  };
  let scope: {
    isUnrestricted: jest.Mock;
    whereForStudents: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      chat_messages: { findMany: jest.fn().mockResolvedValue([]) },
      ticket_messages: { findMany: jest.fn().mockResolvedValue([]) },
      families: { count: jest.fn().mockResolvedValue(0) },
    };

    scope = {
      isUnrestricted: jest.fn().mockReturnValue(false),
      whereForStudents: jest.fn().mockReturnValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: { getFile: jest.fn() } },
        { provide: AuditLogsService, useValue: {} },
        { provide: ScopeService, useValue: scope },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('assertMediaAccess', () => {
    it('throws BadRequestException if key is missing or empty', async () => {
      await expect(service.assertMediaAccess({ role: 'SUPER_ADMIN' }, '')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.assertMediaAccess({ role: 'SUPER_ADMIN' }, null as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException on path traversal key', async () => {
      await expect(
        service.assertMediaAccess({ role: 'SUPER_ADMIN' }, 'chat/../secret.txt'),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows SUPER_ADMIN unconditionally', async () => {
      await expect(
        service.assertMediaAccess({ role: 'SUPER_ADMIN' }, 'chat/voice/2026/10/file.webm'),
      ).resolves.toBeUndefined();
      expect(prisma.chat_messages.findMany).not.toHaveBeenCalled();
    });

    it('allows announcement media for any authenticated parent or staff', async () => {
      prisma.chat_messages.findMany.mockResolvedValue([
        { id: 'msg-1', is_announcement: true, conversation: null },
      ]);

      await expect(
        service.assertMediaAccess(
          { userType: 'PARENT', familyId: 42 },
          'chat/images/2026/10/announcement.jpg',
        ),
      ).resolves.toBeUndefined();
    });

    it('allows a parent to fetch media belonging to their own family (chat)', async () => {
      prisma.chat_messages.findMany.mockResolvedValue([
        { id: 'msg-2', is_announcement: false, conversation: { family_id: 42 } },
      ]);

      await expect(
        service.assertMediaAccess(
          { userType: 'PARENT', familyId: 42 },
          'chat/images/2026/10/photo.jpg',
        ),
      ).resolves.toBeUndefined();
    });

    it('allows a parent to fetch media belonging to their own family (ticket)', async () => {
      prisma.chat_messages.findMany.mockResolvedValue([]);
      prisma.ticket_messages.findMany.mockResolvedValue([
        { id: 'tmsg-1', ticket: { family_id: 42 } },
      ]);

      await expect(
        service.assertMediaAccess(
          { userType: 'PARENT', familyId: 42 },
          'chat/voice/2026/10/voice.webm',
        ),
      ).resolves.toBeUndefined();
    });

    it('forbids a parent from fetching media belonging to another family', async () => {
      prisma.chat_messages.findMany.mockResolvedValue([
        { id: 'msg-2', is_announcement: false, conversation: { family_id: 99 } },
      ]);

      await expect(
        service.assertMediaAccess(
          { userType: 'PARENT', familyId: 42 },
          'chat/images/2026/10/photo.jpg',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows staff to fetch media if the family is within their scope', async () => {
      prisma.chat_messages.findMany.mockResolvedValue([
        { id: 'msg-3', is_announcement: false, conversation: { family_id: 55 } },
      ]);
      prisma.families.count.mockResolvedValue(1);

      await expect(
        service.assertMediaAccess(
          { userType: 'STAFF', sub: 'staff-1', role: 'TEACHER' },
          'chat/docs/2026/10/report.pdf',
        ),
      ).resolves.toBeUndefined();
    });

    it('forbids staff from fetching media if the family is outside their scope', async () => {
      prisma.chat_messages.findMany.mockResolvedValue([
        { id: 'msg-3', is_announcement: false, conversation: { family_id: 55 } },
      ]);
      prisma.families.count.mockResolvedValue(0);

      await expect(
        service.assertMediaAccess(
          { userType: 'STAFF', sub: 'staff-1', role: 'TEACHER' },
          'chat/docs/2026/10/report.pdf',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('forbids media not associated with any chat or ticket message', async () => {
      prisma.chat_messages.findMany.mockResolvedValue([]);
      prisma.ticket_messages.findMany.mockResolvedValue([]);

      await expect(
        service.assertMediaAccess(
          { userType: 'STAFF', sub: 'staff-1', role: 'TEACHER' },
          'chat/misc/2026/10/random.bin',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
