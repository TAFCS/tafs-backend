import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { JwtStaffStrategy } from '../auth/strategies/jwt-staff.strategy';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { userHoldsTile } from '../access/tiles.manifest';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import {
  MCP_TOKEN_MAX_LIVE,
  MCP_TOKEN_TOUCH_INTERVAL_MS,
  checkMcpToken,
  displayPrefix,
  expiryFor,
  generateMcpToken,
  hashMcpToken,
  looksLikeMcpToken,
} from './mcp-token.util';
import { MCP_TILE_ID, MCP_TOKEN_ENTITY } from './mcp.constants';
import type { CreateMcpTokenDto } from './dto/create-mcp-token.dto';

const LIST_SELECT = {
  id: true,
  name: true,
  token_prefix: true,
  created_at: true,
  expires_at: true,
  last_used_at: true,
  revoked_at: true,
} as const;

export const STAFF_USER_SELECT = {
  id: true,
  username: true,
  full_name: true,
  role: true,
  campus_id: true,
  allowed_class_ids: true,
} as const;

export type StaffUserRow = {
  id: string;
  username: string;
  full_name: string;
  role: StaffRole;
  campus_id: number | null;
  allowed_class_ids: number[] | null;
};

/** Whether a principal may use the MCP server at all (the AI Assistant tile). */
export function mayUseMcp(user: IJwtStaffPayload): boolean {
  return (
    user.role === StaffRole.SUPER_ADMIN || userHoldsTile(user, MCP_TILE_ID)
  );
}

@Injectable()
export class McpTokensService {
  private readonly logger = new Logger(McpTokensService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly jwtStaffStrategy: JwtStaffStrategy,
  ) {}

  async list(user: IJwtStaffPayload) {
    const rows = await this.prisma.mcp_access_tokens.findMany({
      where: { user_id: user.sub, grant_id: null },
      select: LIST_SELECT,
      orderBy: { created_at: 'desc' },
    });
    const now = Date.now();
    return rows.map((r) => ({
      ...r,
      status: r.revoked_at
        ? 'revoked'
        : r.expires_at.getTime() <= now
          ? 'expired'
          : 'active',
    }));
  }

  /** Issue a token for the caller. The clear token is returned here and nowhere else. */
  async issue(user: IJwtStaffPayload, dto: CreateMcpTokenDto) {
    // An impersonation session is only good while the admin behind it stays a
    // SUPER_ADMIN; a token minted from it would outlive that check.
    if (user.impersonatorId) {
      throw new ForbiddenException(
        'Tokens cannot be issued while impersonating another user.',
      );
    }
    const now = new Date();
    let expiresAt: Date;
    try {
      expiresAt = expiryFor(now, dto.expires_in_days);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const live = await this.prisma.mcp_access_tokens.count({
      where: {
        user_id: user.sub,
        grant_id: null,
        revoked_at: null,
        expires_at: { gt: now },
      },
    });
    if (live >= MCP_TOKEN_MAX_LIVE) {
      throw new BadRequestException(
        `You already have ${MCP_TOKEN_MAX_LIVE} active tokens. Revoke one before issuing another.`,
      );
    }

    const token = generateMcpToken();
    const row = await this.prisma.mcp_access_tokens.create({
      data: {
        user_id: user.sub,
        name: dto.name.trim(),
        token_prefix: displayPrefix(token),
        token_hash: hashMcpToken(token),
        expires_at: expiresAt,
      },
      select: LIST_SELECT,
    });
    await this.auditLogs.log({
      entity_type: MCP_TOKEN_ENTITY,
      entity_id: row.id,
      action: 'CREATE',
      section: 'system',
      new_value: `${row.name} (expires ${row.expires_at.toISOString().slice(0, 10)})`,
      changed_by: auditActorLabel(user),
    });
    return { ...row, status: 'active', token };
  }

  async revoke(user: IJwtStaffPayload, id: string) {
    const row = await this.prisma.mcp_access_tokens.findFirst({
      where: { id, user_id: user.sub, grant_id: null },
      select: LIST_SELECT,
    });
    if (!row) throw new NotFoundException('Token not found');
    if (row.revoked_at) return { ...row, status: 'revoked' };

    const updated = await this.prisma.mcp_access_tokens.update({
      where: { id },
      data: { revoked_at: new Date() },
      select: LIST_SELECT,
    });
    await this.auditLogs.log({
      entity_type: MCP_TOKEN_ENTITY,
      entity_id: id,
      action: 'REVOKE',
      section: 'system',
      old_value: row.name,
      changed_by: auditActorLabel(user),
    });
    return { ...updated, status: 'revoked' };
  }

  /**
   * The live staff principal for a user, exactly as the browser's JWT guard
   * builds it: role, capabilities, tile actions and scope are read now, not
   * remembered. Throws 401 for an inactive account.
   */
  async livePrincipal(u: StaffUserRow): Promise<IJwtStaffPayload> {
    return this.jwtStaffStrategy.validate({
      sub: u.id,
      username: u.username,
      fullName: u.full_name,
      role: u.role,
      campusId: u.campus_id,
      allowedClassIds: u.allowed_class_ids ?? [],
      userType: 'STAFF',
      permissions: [],
    });
  }

  /**
   * Bearer token → the same staff principal the browser's JWT guard builds.
   *
   * Accepts a personal access token or an OAuth access token; both are rows
   * here. The token only names the user. Everything else comes from
   * livePrincipal, so every existing policy and scope check applies to MCP
   * calls unchanged and losing access in the ERP loses it here on the next
   * request. Throws 401 for any token that does not let the caller in; the
   * message never says which rule failed, so a stolen-but-revoked token
   * cannot be told from a typo.
   *
   * `credential` names what was used, for audit rows: the token id, or the
   * OAuth grant id (an OAuth access token changes every hour, its grant not).
   */
  async authenticate(
    presented: string | null,
  ): Promise<{ user: IJwtStaffPayload; credential: string }> {
    const deny = () =>
      new UnauthorizedException('Invalid or expired MCP token');
    if (!looksLikeMcpToken(presented)) throw deny();

    const row = await this.prisma.mcp_access_tokens.findUnique({
      where: { token_hash: hashMcpToken(presented) },
      select: {
        id: true,
        user_id: true,
        token_hash: true,
        expires_at: true,
        revoked_at: true,
        last_used_at: true,
        grant_id: true,
        grant: { select: { revoked_at: true, expires_at: true } },
        users: { select: STAFF_USER_SELECT },
      },
    });
    const verdict = checkMcpToken(presented, row, new Date());
    if (!verdict.ok || !row) throw deny();
    if (
      row.grant_id &&
      (!row.grant ||
        row.grant.revoked_at ||
        row.grant.expires_at.getTime() <= Date.now())
    ) {
      throw deny();
    }

    const principal = await this.livePrincipal(row.users);
    if (!mayUseMcp(principal)) {
      throw new ForbiddenException(
        'Your access does not include the AI Assistant (MCP).',
      );
    }

    const lastUsed = row.last_used_at?.getTime() ?? 0;
    if (Date.now() - lastUsed > MCP_TOKEN_TOUCH_INTERVAL_MS) {
      const now = new Date();
      const touches: Promise<unknown>[] = [
        this.prisma.mcp_access_tokens.update({
          where: { id: row.id },
          data: { last_used_at: now },
        }),
      ];
      if (row.grant_id) {
        touches.push(
          this.prisma.mcp_oauth_grants.update({
            where: { id: row.grant_id },
            data: { last_used_at: now },
          }),
        );
      }
      Promise.all(touches).catch((err) =>
        this.logger.warn(
          `last_used_at update failed: ${(err as Error).message}`,
        ),
      );
    }
    return {
      user: principal,
      credential: row.grant_id
        ? `oauth grant ${row.grant_id}`
        : `token ${row.id}`,
    };
  }
}
