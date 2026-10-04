import { Test, TestingModule } from '@nestjs/testing';
import { ChatService } from './chat.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';

describe('ChatService', () => {
  let service: ChatService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: {} },
        { provide: StorageService, useValue: {} },
        { provide: AuditLogsService, useValue: {} },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
