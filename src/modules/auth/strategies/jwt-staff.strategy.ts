import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { IJwtStaffPayload } from '../interfaces/jwt-payload.interface';
import { PrismaService } from '../../../../prisma/prisma.service';

@Injectable()
export class JwtStaffStrategy extends PassportStrategy(Strategy, 'jwt-staff') {
  constructor(
    configService: ConfigService,
    private prisma: PrismaService,
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

    const user = await this.prisma.users.findUnique({
      where: { id: payload.sub },
      select: { id: true, is_active: true },
    });

    if (!user || !user.is_active) {
      throw new UnauthorizedException('Account is inactive');
    }

    return {
      ...payload,
      allowedClassIds: payload.allowedClassIds ?? [],
      permissions: payload.permissions ?? [],
    };
  }
}
