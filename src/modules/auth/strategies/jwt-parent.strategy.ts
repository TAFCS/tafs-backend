import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { IJwtParentPayload } from '../interfaces/jwt-payload.interface';

@Injectable()
export class JwtParentStrategy extends PassportStrategy(
  Strategy,
  'jwt-parent',
) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') as string,
    });
  }

  async validate(payload: IJwtParentPayload): Promise<IJwtParentPayload> {
    if (payload.userType !== 'PARENT') {
      throw new UnauthorizedException('Invalid token type');
    }
    return payload;
  }
}
