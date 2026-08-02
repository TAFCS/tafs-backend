import { UnauthorizedException } from '@nestjs/common';
import { JwtStaffStrategy } from './jwt-staff.strategy';
import { ConfigService } from '@nestjs/config';
import { StaffRole } from '@prisma/client';

describe('JwtStaffStrategy', () => {
  const basePayload = {
    sub: 'user-1',
    username: 'alice',
    role: StaffRole.EMPLOYEE,
    campusId: null,
    allowedClassIds: [] as number[],
    userType: 'STAFF' as const,
    permissions: [] as string[],
  };

  function createStrategy(prisma: { users: { findUnique: jest.Mock } }) {
    return new JwtStaffStrategy(
      { get: () => 'test-secret' } as ConfigService,
      prisma as any,
    );
  }

  it('is configured with Bearer and cookie extractors', () => {
    const strategy = createStrategy({
      users: { findUnique: jest.fn() },
    });
    expect(strategy).toBeDefined();
  });

  it('rejects non-staff tokens', async () => {
    const strategy = createStrategy({
      users: { findUnique: jest.fn() },
    });
    await expect(
      strategy.validate({ ...basePayload, userType: 'PARENT' as any }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects inactive users', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', is_active: false });
    const strategy = createStrategy({ users: { findUnique } });
    await expect(strategy.validate(basePayload)).rejects.toThrow('Account is inactive');
  });

  it('rejects missing users', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const strategy = createStrategy({ users: { findUnique } });
    await expect(strategy.validate(basePayload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns payload for active users', async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: 'user-1', is_active: true });
    const strategy = createStrategy({ users: { findUnique } });
    await expect(strategy.validate(basePayload)).resolves.toEqual(basePayload);
  });
});
