import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import { JwtStaffOrParentGuard } from '../../common/guards/jwt-staff-or-parent.guard';

describe('ChatController', () => {
  let controller: ChatController;
  let chatService: {
    assertMediaAccess: jest.Mock;
    getMediaFile: jest.Mock;
  };

  beforeEach(async () => {
    chatService = {
      assertMediaAccess: jest.fn().mockResolvedValue(undefined),
      getMediaFile: jest.fn().mockResolvedValue({
        buffer: Buffer.from('fake-audio'),
        mime: 'audio/webm',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: chatService },
        { provide: ChatGateway, useValue: {} },
        { provide: Reflector, useValue: new Reflector() },
        { provide: CaslAbilityFactory, useValue: { createForStaff: jest.fn() } },
      ],
    })
      .overrideGuard(JwtStaffOrParentGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ChatController>(ChatController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('proxyMedia', () => {
    it('cleans key, checks media access, and responds with private Cache-Control', async () => {
      const mockRes = {
        set: jest.fn(),
        send: jest.fn(),
      };
      const user = { userType: 'STAFF', role: 'SUPER_ADMIN' };
      const rawKey = 'https://tafs-assets.sgp1.cdn.digitaloceanspaces.com/chat/voice/2026/10/note.webm';

      await controller.proxyMedia(user, rawKey, mockRes);

      expect(chatService.assertMediaAccess).toHaveBeenCalledWith(
        user,
        'chat/voice/2026/10/note.webm',
      );
      expect(chatService.getMediaFile).toHaveBeenCalledWith('chat/voice/2026/10/note.webm');
      expect(mockRes.set).toHaveBeenCalledWith('Content-Type', 'audio/webm');
      expect(mockRes.set).toHaveBeenCalledWith('Cache-Control', 'private, max-age=3600');
      expect(mockRes.send).toHaveBeenCalledWith(Buffer.from('fake-audio'));
    });
  });
});
