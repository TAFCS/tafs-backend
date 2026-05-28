import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { IJwtParentPayload } from '../interfaces/jwt-payload.interface';
import { PrismaService } from '../../../../prisma/prisma.service';

@Injectable()
export class JwtParentStrategy extends PassportStrategy(
  Strategy,
  'jwt-parent',
) {
  constructor(
    configService: ConfigService,
    private prisma: PrismaService,
  ) {
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

    const family = await this.prisma.families.findUnique({
      where: { id: payload.familyId },
      select: { id: true, deleted_at: true, password_hash: true },
    });
    if (!family || family.deleted_at || !family.password_hash) {
      throw new UnauthorizedException('Account is deleted');
    }

    return payload;
  }
}
