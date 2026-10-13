import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScopeService } from '../scope/scope.service';
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
  ) {}

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
        // Same as JwtStaffStrategy.validate: an inactive account is refused,
        // and scope is read live rather than trusted from the 90-day token.
        const [user, scope] = await Promise.all([
          this.prisma.users.findUnique({
            where: { id: payload.sub },
            select: { is_active: true },
          }),
          this.scopeService.resolveEffective(payload.sub),
        ]);
        if (!user || !user.is_active) {
          throw new UnauthorizedException('Account is inactive');
        }
        request.user = {
          ...payload,
          allowedClassIds: payload.allowedClassIds ?? [],
          permissions: payload.permissions ?? [],
          actions: payload.actions ?? [],
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
