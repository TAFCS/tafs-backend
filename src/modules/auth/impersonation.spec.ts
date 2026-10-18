import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { StaffRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { JwtStaffStrategy } from './strategies/jwt-staff.strategy';
import { ScopeService } from '../../common/scope/scope.service';
import { AccessService } from '../access/access.service';

jest.mock('uuid', () => ({ v4: () => 'uuid' }));

/** TAFSD-361: super admins can act as another staff user and exit back. */
describe('staff impersonation', () => {
  const config = { get: (k: string) => (k === 'JWT_REFRESH_SECRET' ? 'refresh' : 'access') } as ConfigService;
  const jwt = new JwtService({});

  const admin = {
    sub: 'admin-1',
    username: 'admin',
    fullName: 'Admin One',
    role: StaffRole.SUPER_ADMIN,
    campusId: null,
    allowedClassIds: [] as number[],
    userType: 'STAFF' as const,
    permissions: [] as string[],
  };
  const target = {
    id: 'user-2',
    username: 'amna',
    full_name: 'Amna',
    role: StaffRole.EMPLOYEE,
    campus_id: 1,
    allowed_class_ids: [],
    is_active: true,
    campuses: { campus_name: 'GEJ' },
  };

  function service(row: any = target) {
    const auditLogs = { log: jest.fn() };
    const prisma = {
      users: { findUnique: jest.fn().mockResolvedValue(row) },
      employee_profiles: { findUnique: jest.fn().mockResolvedValue(null) },
      user_refresh_tokens: { create: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    };
    const permissions = {
      getEffectiveAccess: jest.fn().mockResolvedValue({ capabilityKeys: [], tileIds: [], actionIds: [] }),
    };
    const scope = { resolveEffective: jest.fn().mockResolvedValue({}) };
    const svc = new AuthService(
      {} as any, permissions as any, jwt, config, prisma as any,
      {} as any, {} as any, auditLogs as any, scope as any,
    );
    return { svc, prisma, auditLogs };
  }

  it('issues a target token carrying the admin, without touching the target refresh tokens', async () => {
    const { svc, prisma, auditLogs } = service();
    const { accessToken, user } = await svc.impersonateStaff(admin, target.id);
    const decoded = jwt.verify(accessToken, { secret: 'access' });
    expect(decoded).toMatchObject({ sub: 'user-2', impersonatorId: 'admin-1', impersonatorName: 'Admin One' });
    expect(decoded.exp - decoded.iat).toBe(2 * 60 * 60);
    expect(user.impersonator).toEqual({ id: 'admin-1', fullName: 'Admin One' });
    expect(prisma.user_refresh_tokens.updateMany).not.toHaveBeenCalled();
    expect(prisma.user_refresh_tokens.create).not.toHaveBeenCalled();
    expect(auditLogs.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'IMPERSONATION_STARTED', entity_id: 'user-2' }));
  });

  it('is super admin only', async () => {
    await expect(service().svc.impersonateStaff({ ...admin, role: StaffRole.CAMPUS_ADMIN }, target.id))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses self, another super admin, inactive users and nested impersonation', async () => {
    await expect(service().svc.impersonateStaff(admin, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service({ ...target, role: StaffRole.SUPER_ADMIN }).svc.impersonateStaff(admin, target.id))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(service({ ...target, is_active: false }).svc.impersonateStaff(admin, target.id))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service().svc.impersonateStaff({ ...admin, impersonatorId: 'x' }, target.id))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('exit refuses a refresh cookie that is not the impersonating admin', async () => {
    const { svc } = service();
    const { accessToken } = await svc.impersonateStaff(admin, target.id);
    const otherRefresh = jwt.sign({ sub: 'someone-else', userType: 'STAFF' }, { secret: 'refresh' });
    await expect(svc.exitImpersonation(otherRefresh, accessToken)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('strategy', () => {
    function strategy(roles: Record<string, { is_active: boolean; role: StaffRole }>) {
      const findUnique = jest.fn(async ({ where }: any) => roles[where.id] ?? null);
      const scopeService = new ScopeService({
        user_scope_entries: { findMany: jest.fn().mockResolvedValue([]) },
        classes: { findMany: jest.fn().mockResolvedValue([]) },
      } as any);
      const access = new AccessService({ users: { findUnique } } as any, {} as any, scopeService);
      jest.spyOn(access, 'resolveEffective').mockResolvedValue({ capabilityKeys: [], tileIds: [], actionIds: [] } as any);
      return new JwtStaffStrategy(config, scopeService, access);
    }
    const token = {
      ...admin, sub: 'user-2', username: 'amna', fullName: 'Amna', role: StaffRole.EMPLOYEE,
      impersonatorId: 'admin-1', impersonatorName: 'Admin One',
    };

    it('credits the admin in fullName', async () => {
      const s = strategy({
        'user-2': { is_active: true, role: StaffRole.EMPLOYEE },
        'admin-1': { is_active: true, role: StaffRole.SUPER_ADMIN },
      });
      await expect(s.validate(token)).resolves.toMatchObject({ sub: 'user-2', fullName: 'Admin One (as Amna)' });
    });

    it('rejects the token once the admin is no longer an active super admin', async () => {
      const s = strategy({
        'user-2': { is_active: true, role: StaffRole.EMPLOYEE },
        'admin-1': { is_active: true, role: StaffRole.CAMPUS_ADMIN },
      });
      await expect(s.validate(token)).rejects.toThrow('Impersonation is no longer allowed');
    });
  });
});
