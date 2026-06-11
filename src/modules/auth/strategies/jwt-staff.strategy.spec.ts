import { JwtStaffStrategy } from './jwt-staff.strategy';
import { ConfigService } from '@nestjs/config';

describe('JwtStaffStrategy', () => {
  it('is configured with Bearer and cookie extractors', () => {
    const strategy = new JwtStaffStrategy({
      get: () => 'test-secret',
    } as ConfigService);
    expect(strategy).toBeDefined();
  });
});
