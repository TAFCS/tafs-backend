import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';

describe('ChatController', () => {
  let controller: ChatController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: {} },
        { provide: ChatGateway, useValue: {} },
        { provide: Reflector, useValue: new Reflector() },
        { provide: CaslAbilityFactory, useValue: { createForStaff: jest.fn() } },
      ],
    }).compile();

    controller = module.get<ChatController>(ChatController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
