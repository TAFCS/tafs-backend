import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { IJwtStaffPayload } from '../interfaces/jwt-payload.interface';

@Injectable()
export class JwtStaffStrategy extends PassportStrategy(Strategy, 'jwt-staff') {
  constructor(configService: ConfigService) {
    super({
      // Staff tokens are delivered via httpOnly cookie — never Authorization header
      jwtFromRequest: ExtractJwt.fromExtractors([
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
    return payload;
  }
}
