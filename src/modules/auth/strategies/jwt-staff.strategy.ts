import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { IJwtStaffPayload } from '../interfaces/jwt-payload.interface';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ScopeService } from '../../../common/scope/scope.service';

@Injectable()
export class JwtStaffStrategy extends PassportStrategy(Strategy, 'jwt-staff') {
  constructor(
    configService: ConfigService,
    private prisma: PrismaService,
    private scopeService: ScopeService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: Request) => {
          const token = req?.cookies?.['tafs_access'];
          return typeof token === 'string' ? token : null;
        },
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') as string,
    });
  }

  private userStatusCache = new Map<string, { is_active: boolean; expires: number }>();

  async validate(payload: IJwtStaffPayload): Promise<IJwtStaffPayload> {
    if (payload.userType !== 'STAFF') {
      throw new UnauthorizedException('Invalid token type');
    }

    const now = Date.now();
    const cachedUser = this.userStatusCache.get(payload.sub);
    const needUserCheck = !cachedUser || cachedUser.expires <= now;

    // Scope is read live, never trusted from the token. A short in-memory cache
    // absorbs concurrent requests on page loads.
    const [user, scope] = await Promise.all([
      needUserCheck
        ? this.prisma.users.findUnique({
            where: { id: payload.sub },
            select: { id: true, is_active: true },
          })
        : null,
      this.scopeService.resolveEffective(payload.sub),
    ]);

    let isActive: boolean;
    if (needUserCheck) {
      if (!user) {
        throw new UnauthorizedException('Account not found');
      }
      isActive = Boolean(user.is_active);
      this.userStatusCache.set(payload.sub, { is_active: isActive, expires: now + 30_000 });
    } else {
      isActive = cachedUser!.is_active;
    }

    if (!isActive) {
      throw new UnauthorizedException('Account is inactive');
    }

    return {
      ...payload,
      allowedClassIds: payload.allowedClassIds ?? [],
      permissions: payload.permissions ?? [],
      // Absent on sessions issued before sub-permissions shipped. Empty
      // actions means "no sub-permissions" -- what those sessions already had.
      actions: payload.actions ?? [],
      scope,
    };
  }
}
