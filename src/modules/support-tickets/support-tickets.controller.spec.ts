import { Test, TestingModule } from '@nestjs/testing';
import { SupportTicketsController } from './support-tickets.controller';
import { SupportTicketsService } from './support-tickets.service';
import { ChatService } from '../chat/chat.service';

describe('SupportTicketsController', () => {
  let controller: SupportTicketsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SupportTicketsController],
      providers: [
        { provide: SupportTicketsService, useValue: {} },
        { provide: ChatService, useValue: {} },
      ],
    }).compile();

    controller = module.get<SupportTicketsController>(SupportTicketsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
