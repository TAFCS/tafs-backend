import { Test, TestingModule } from '@nestjs/testing';
import { SupportTicketsController } from './support-tickets.controller';
import { SupportTicketsService } from './support-tickets.service';
import { ChatService } from '../chat/chat.service';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { JwtParentGuard } from '../../common/guards/jwt-parent.guard';
import { JwtStaffOrParentGuard } from '../../common/guards/jwt-staff-or-parent.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { REQUIRE_ACTION_KEY } from '../../decorators/require-action.decorator';

describe('SupportTicketsController', () => {
  let controller: SupportTicketsController;
  const service = { listSentReplies: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SupportTicketsController],
      providers: [
        { provide: SupportTicketsService, useValue: service },
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

  describe('GET sent (TAFSD-536)', () => {
    beforeEach(() => service.listSentReplies.mockReset());

    it('passes the caller, status and parsed pagination through', () => {
      const staff = { sub: 'staff-1' };
      controller.sentReplies(staff, 'approved', '20', '40');
      expect(service.listSentReplies).toHaveBeenCalledWith(staff, 'approved', 20, 40);
    });

    it('defaults to every status, 50 rows from the start', () => {
      const staff = { sub: 'staff-1' };
      controller.sentReplies(staff);
      expect(service.listSentReplies).toHaveBeenCalledWith(staff, undefined, 50, 0);
    });

    it('rejects bad pagination', () => {
      expect(() => controller.sentReplies({ sub: 's' }, undefined, '0')).toThrow('Invalid pagination');
    });

    it('is guarded like its siblings and requires the respond action', () => {
      const guards = Reflect.getMetadata('__guards__', SupportTicketsController.prototype.sentReplies);
      expect(guards).toEqual([JwtStaffGuard, PoliciesGuard, TileActionGuard]);
      expect(Reflect.getMetadata(REQUIRE_ACTION_KEY, SupportTicketsController.prototype.sentReplies)).toEqual({
        mode: 'all',
        actionKeys: ['communication.support_tickets#respond'],
      });
    });

    it("is declared before GET ':id' so 'sent' is not read as a ticket id", () => {
      const names = Object.getOwnPropertyNames(SupportTicketsController.prototype);
      expect(names.indexOf('sentReplies')).toBeGreaterThan(-1);
      expect(names.indexOf('sentReplies')).toBeLessThan(names.indexOf('getTicket'));
    });
  });
});
