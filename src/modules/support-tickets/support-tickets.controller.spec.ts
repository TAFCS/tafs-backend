import { Test, TestingModule } from '@nestjs/testing';
import { SupportTicketsController } from './support-tickets.controller';
import { SupportTicketsService } from './support-tickets.service';
import { ChatService } from '../chat/chat.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { JwtStaffOrParentGuard } from '../../common/guards/jwt-staff-or-parent.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';

describe('SupportTicketsController', () => {
  let controller: SupportTicketsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SupportTicketsController],
      providers: [
        { provide: SupportTicketsService, useValue: {} },
        { provide: ChatService, useValue: {} },
      ],
    })
      .overrideGuard(JwtStaffGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(JwtParentGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(JwtStaffOrParentGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PoliciesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TileActionGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<SupportTicketsController>(SupportTicketsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
