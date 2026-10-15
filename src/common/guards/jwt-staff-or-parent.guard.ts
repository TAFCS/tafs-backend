import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScopeService } from '../scope/scope.service';
import { AccessService } from '../../modules/access/access.service';
import {
  IJwtParentPayload,
  IJwtStaffPayload,
} from '../../modules/auth/interfaces/jwt-payload.interface';

@Injectable()
export class JwtStaffOrParentGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly scopeService: ScopeService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Resolved lazily and app-wide: this guard is attached in many modules that
   * do not import AccessModule, so it cannot take AccessService as a
   * constructor dependency.
   */
  private accessService?: AccessService;
  private access(): AccessService {
    this.accessService ??= this.moduleRef.get(AccessService, { strict: false });
    return this.accessService;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException();
    }

    try {
      const payload = this.jwtService.verify(token) as
        | IJwtStaffPayload
        | IJwtParentPayload;

      if (payload.userType === 'STAFF') {
        // Same as JwtStaffStrategy.validate: account state, role,
        // capabilities, tile actions and scope are read live, never trusted
        // from the 90-day token (TAFSD-307, TAFSD-308).
        const [session, scope] = await Promise.all([
          this.access().resolveLiveSession(payload.sub),
          this.scopeService.resolveEffective(payload.sub),
        ]);
        if (!session) {
          throw new UnauthorizedException('Account not found');
        }
        if (!session.isActive) {
          throw new UnauthorizedException('Account is inactive');
        }
        request.user = {
          ...payload,
          role: session.role,
          allowedClassIds: payload.allowedClassIds ?? [],
          permissions: session.capabilityKeys,
          actions: session.actionIds,
          scope,
        };
        return true;
      }

      if (payload.userType === 'PARENT') {
        const family = await this.prisma.families.findUnique({
          where: { id: payload.familyId },
        });
        if (!family || family.deleted_at) {
          throw new UnauthorizedException('Family account inactive');
        }
        request.user = payload;
        return true;
      }

      throw new UnauthorizedException();
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException();
    }
  }

  private extractToken(request: {
    headers?: { authorization?: string; cookie?: string };
  }): string | null {
    const authHeader = request.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
    const cookie = request.headers?.cookie;
    if (cookie) {
      const match = cookie.match(/(?:^|;\s*)tafs_access=([^;]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    return null;
  }
}
