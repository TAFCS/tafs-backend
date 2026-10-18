import { Inject, Injectable, UnauthorizedException, forwardRef } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { StaffRole } from '@prisma/client';
import { IJwtStaffPayload } from '../interfaces/jwt-payload.interface';
import { ScopeService } from '../../../common/scope/scope.service';
import { AccessService } from '../../access/access.service';

@Injectable()
export class JwtStaffStrategy extends PassportStrategy(Strategy, 'jwt-staff') {
  constructor(
    configService: ConfigService,
    private scopeService: ScopeService,
    @Inject(forwardRef(() => AccessService))
    private accessService: AccessService,
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

    // Account state, role, capabilities, tile actions and scope are all read
    // live, never trusted from the 90-day token (TAFSD-307 scope, TAFSD-308
    // the rest): revoking access takes effect on the next request. Both reads
    // sit behind short in-memory caches that access writes invalidate.
    // Sequential on purpose: Promise.all doubled cold-path DB connections
    // (session alone already fans out several queries) and exhausted DO's
    // max_connections when local + Railway shared the same database.
    const session = await this.accessService.resolveLiveSession(payload.sub);
    const scope = await this.scopeService.resolveEffective(payload.sub);

    if (!session) {
      throw new UnauthorizedException('Account not found');
    }
    if (!session.isActive) {
      throw new UnauthorizedException('Account is inactive');
    }

    // An impersonation token is only good while the admin behind it is still
    // an active SUPER_ADMIN. Their name goes into fullName so audit rows and
    // anything else that records "who" credit the admin, not the target.
    let fullName = payload.fullName;
    if (payload.impersonatorId) {
      const impersonator = await this.accessService.resolveLiveSession(payload.impersonatorId);
      if (!impersonator?.isActive || impersonator.role !== StaffRole.SUPER_ADMIN) {
        throw new UnauthorizedException('Impersonation is no longer allowed');
      }
      fullName = `${payload.impersonatorName ?? 'Admin'} (as ${payload.fullName ?? payload.username})`;
    }

    return {
      ...payload,
      fullName,
      role: session.role,
      allowedClassIds: payload.allowedClassIds ?? [],
      permissions: session.capabilityKeys,
      actions: session.actionIds,
      scope,
    };
  }
}
