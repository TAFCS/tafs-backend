import { StaffRole } from '@prisma/client';
import { Action } from './actions';
import { CaslAbilityFactory } from './casl-ability.factory';
import { IJwtStaffPayload } from '../interfaces/jwt-payload.interface';

describe('CaslAbilityFactory', () => {
  const factory = new CaslAbilityFactory();

  const staff = (overrides: Partial<IJwtStaffPayload> = {}): IJwtStaffPayload => ({
    sub: 'user-1',
    username: 'test.user',
    role: StaffRole.PRINCIPAL,
    campusId: 1,
    allowedClassIds: [],
    userType: 'STAFF',
    permissions: [],
    ...overrides,
  });

  it('grants SupportTicket read for communication.support_tickets.view', () => {
    const ability = factory.createForStaff(
      staff({
        permissions: ['communication.support_tickets.view', 'communication.view_chats'],
      }),
    );

    expect(ability.can(Action.Read, 'SupportTicket')).toBe(true);
  });

  it('maps communication.view_chats to Chat read', () => {
    const ability = factory.createForStaff(
      staff({ permissions: ['communication.view_chats'] }),
    );

    expect(ability.can(Action.Read, 'Chat')).toBe(true);
    expect(ability.can(Action.Manage, 'Chat')).toBe(false);
  });

  it('maps communication.send_announcements to Chat manage', () => {
    const ability = factory.createForStaff(
      staff({ permissions: ['communication.send_announcements'] }),
    );

    expect(ability.can(Action.Manage, 'Chat')).toBe(true);
  });
});
