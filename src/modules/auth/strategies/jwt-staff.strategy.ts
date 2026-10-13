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

  async validate(payload: IJwtStaffPayload): Promise<IJwtStaffPayload> {
    if (payload.userType !== 'STAFF') {
      throw new UnauthorizedException('Invalid token type');
    }

    // Scope is read live, never trusted from the token. The access token lives
    // 90 days, so a scope baked into it outlived every narrowing an admin made:
    // the API kept serving the old, wider data until the client happened to
    // refresh, and requests fired before that refresh landed used it too.
    const [user, scope] = await Promise.all([
      this.prisma.users.findUnique({
        where: { id: payload.sub },
        select: { id: true, is_active: true },
      }),
      this.scopeService.resolveEffective(payload.sub),
    ]);

    if (!user || !user.is_active) {
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
