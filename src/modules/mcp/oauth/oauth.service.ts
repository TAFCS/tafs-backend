import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { auditActorLabel } from '../../../common/utils/audit-actor.util';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import {
  McpTokensService,
  STAFF_USER_SELECT,
  StaffUserRow,
  mayUseMcp,
} from '../mcp-tokens.service';
import { McpService } from '../mcp.service';
import { MCP_OAUTH_ENTITY } from '../mcp.constants';
import { displayPrefix } from '../mcp-token.util';
import {
  MCP_RESOURCE_PATH,
  OAUTH_ACCESS_PREFIX,
  OAUTH_ACCESS_TTL_MS,
  OAUTH_BASE_PATH,
  OAUTH_CODE_PREFIX,
  OAUTH_CODE_TTL_MS,
  OAUTH_GRANT_TTL_MS,
  OAUTH_MAX_REDIRECT_URIS,
  OAUTH_REFRESH_PREFIX,
  OAUTH_REFRESH_TTL_MS,
  OAUTH_SCOPE,
  OAUTH_TICKET_AUDIENCE,
  OAUTH_TICKET_TTL_S,
  earliest,
  grantedScope,
  hasShape,
  hashOAuthSecret,
  isAllowedRedirectUri,
  isValidChallenge,
  newClientId,
  newToken,
  redirectHostsFrom,
  redirectUriMatches,
  sameResource,
  verifyPkce,
  withParams,
} from './oauth.util';

/** An OAuth protocol error, answered as `{ error, error_description }`. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
  toJSON() {
    return { error: this.error, error_description: this.description };
  }
}

/** What the signed authorize ticket carries between /authorize and the consent screen. */
type AuthorizeTicket = {
  /** The issuer, fixed at /authorize: the consent calls arrive through the webapp's proxy. */
  iss: string;
  cid: string;
  ru: string;
  cc: string;
  st?: string;
  sc: string;
  rs?: string;
};

export type TokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
};

const GRANT_LIST_SELECT = {
  id: true,
  scope: true,
  created_at: true,
  expires_at: true,
  last_used_at: true,
  revoked_at: true,
  revoked_reason: true,
  client: {
    select: {
      id: true,
      client_name: true,
      client_uri: true,
      redirect_uris: true,
    },
  },
} as const;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

/**
 * TAFSD-531: OAuth 2.1 authorization for the admin MCP server, following the
 * MCP authorization spec: protected-resource and authorization-server
 * metadata, dynamic client registration, authorization code + PKCE (S256
 * only), rotating refresh tokens, revocation.
 *
 * Every token it issues is an mcp_access_tokens row tied to a grant, so the
 * MCP endpoint checks it exactly like a personal token: the person's role,
 * tiles and scope are read live on every request.
 */
@Injectable()
export class McpOAuthService {
  private readonly logger = new Logger(McpOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
    private readonly jwt: JwtService,
    private readonly tokens: McpTokensService,
    private readonly mcp: McpService,
  ) {}

  // ── URLs and metadata ────────────────────────────────────────────────────

  /**
   * The backend's public origin. MCP_PUBLIC_URL when set (production: the
   * URL people configure in their clients); otherwise read from the request,
   * honouring the proxy's forwarded headers.
   */
  baseUrl(req: Request): string {
    const configured = process.env.MCP_PUBLIC_URL?.trim().replace(/\/+$/, '');
    if (configured) return configured;
    const header = (name: string) => {
      const v = req.headers[name];
      return (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim();
    };
    const proto = header('x-forwarded-proto') || req.protocol || 'http';
    const host = header('x-forwarded-host') || header('host') || 'localhost';
    return `${proto}://${host}`;
  }

  resourceUrl(req: Request): string {
    return this.baseUrl(req) + MCP_RESOURCE_PATH;
  }

  resourceMetadataUrl(req: Request): string {
    return `${this.baseUrl(req)}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;
  }

  protectedResourceMetadata(req: Request) {
    return {
      resource: this.resourceUrl(req),
      authorization_servers: [this.baseUrl(req)],
      scopes_supported: [OAUTH_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'TAFS admin MCP',
    };
  }

  authorizationServerMetadata(req: Request) {
    const base = this.baseUrl(req);
    return {
      issuer: base,
      authorization_endpoint: `${base}${OAUTH_BASE_PATH}/authorize`,
      token_endpoint: `${base}${OAUTH_BASE_PATH}/token`,
      registration_endpoint: `${base}${OAUTH_BASE_PATH}/register`,
      revocation_endpoint: `${base}${OAUTH_BASE_PATH}/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [OAUTH_SCOPE],
      authorization_response_iss_parameter_supported: true,
    };
  }

  // ── Dynamic client registration (RFC 7591) ───────────────────────────────

  async register(body: Record<string, unknown>) {
    const allowedHosts = redirectHostsFrom(
      process.env.MCP_OAUTH_REDIRECT_HOSTS,
    );
    const uris = body.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      uris.length > OAUTH_MAX_REDIRECT_URIS
    ) {
      throw new OAuthError(
        'invalid_redirect_uri',
        `redirect_uris must list 1 to ${OAUTH_MAX_REDIRECT_URIS} URIs`,
      );
    }
    const bad = uris.find((u) => !isAllowedRedirectUri(u, allowedHosts));
    if (bad !== undefined) {
      throw new OAuthError(
        'invalid_redirect_uri',
        `redirect URI not allowed: ${String(bad).slice(0, 200)}. Use http://localhost or https on ${allowedHosts.join(', ')}.`,
      );
    }
    const method = str(body.token_endpoint_auth_method) ?? 'none';
    if (method !== 'none') {
      throw new OAuthError(
        'invalid_client_metadata',
        'Only public clients are supported (token_endpoint_auth_method "none")',
      );
    }
    const grantTypes = Array.isArray(body.grant_types)
      ? body.grant_types
      : ['authorization_code', 'refresh_token'];
    if (
      grantTypes.some(
        (g) => g !== 'authorization_code' && g !== 'refresh_token',
      )
    ) {
      throw new OAuthError(
        'invalid_client_metadata',
        'grant_types may only include authorization_code and refresh_token',
      );
    }
    const responseTypes = Array.isArray(body.response_types)
      ? body.response_types
      : ['code'];
    if (responseTypes.some((r) => r !== 'code')) {
      throw new OAuthError(
        'invalid_client_metadata',
        'response_types may only include code',
      );
    }
    const name = (str(body.client_name) ?? 'Unnamed MCP client')
      .trim()
      .slice(0, 200);
    const clientUri = str(body.client_uri);
    const client = await this.prisma.mcp_oauth_clients.create({
      data: {
        id: newClientId(),
        client_name: name,
        client_uri:
          clientUri && /^https:\/\//i.test(clientUri)
            ? clientUri.slice(0, 500)
            : null,
        redirect_uris: uris as string[],
      },
    });
    await this.audit(
      'system',
      client.id,
      'CLIENT_REGISTER',
      `${name} → ${(uris as string[]).map(hostOf).join(', ')}`,
    );
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.created_at.getTime() / 1000),
      client_name: client.client_name,
      ...(client.client_uri ? { client_uri: client.client_uri } : {}),
      redirect_uris: client.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  // ── Authorize ────────────────────────────────────────────────────────────

  /**
   * Check an authorization request and send the browser to the webapp's
   * consent page. Until the client and redirect URI are known good, errors are
   * shown, never redirected (RFC 6749 §4.1.2.1); after that they go back to
   * the client as `error=` on its redirect URI.
   */
  async authorize(
    query: Record<string, unknown>,
    req: Request,
  ): Promise<{ redirect: string } | { status: number; message: string }> {
    const clientId = str(query.client_id);
    const redirectUri = str(query.redirect_uri);
    const client = clientId
      ? await this.prisma.mcp_oauth_clients.findUnique({
          where: { id: clientId },
        })
      : null;
    if (!client)
      return {
        status: 400,
        message: 'Unknown client. The app must register again.',
      };
    if (
      !redirectUri ||
      !redirectUriMatches(redirectUri, client.redirect_uris)
    ) {
      return {
        status: 400,
        message: 'The redirect URI is not registered for this app.',
      };
    }

    const state = str(query.state);
    const iss = this.baseUrl(req);
    const fail = (error: string, description: string) => ({
      redirect: withParams(redirectUri, {
        error,
        error_description: description,
        state,
        iss,
      }),
    });

    if (query.response_type !== 'code')
      return fail('unsupported_response_type', 'response_type must be code');
    if (query.code_challenge_method !== 'S256')
      return fail(
        'invalid_request',
        'PKCE with code_challenge_method S256 is required',
      );
    if (!isValidChallenge(query.code_challenge))
      return fail(
        'invalid_request',
        'code_challenge must be an S256 challenge',
      );
    const scope = grantedScope(query.scope);
    if (!scope)
      return fail('invalid_scope', `The only scope is "${OAUTH_SCOPE}"`);
    const resource = str(query.resource);
    if (resource && !sameResource(resource, this.resourceUrl(req))) {
      return fail('invalid_target', 'resource is not this MCP server');
    }

    const webapp = process.env.WEBAPP_URL?.trim().replace(/\/+$/, '');
    if (!webapp) {
      this.logger.error(
        'WEBAPP_URL is not set; MCP OAuth sign-in cannot show its consent page',
      );
      return fail(
        'temporarily_unavailable',
        'Sign-in is not configured on this server',
      );
    }
    const ticket: AuthorizeTicket = {
      iss,
      cid: client.id,
      ru: redirectUri,
      cc: query.code_challenge,
      sc: scope,
    };
    if (state) ticket.st = state;
    if (resource) ticket.rs = resource;
    const signed = await this.jwt.signAsync(ticket, {
      audience: OAUTH_TICKET_AUDIENCE,
      expiresIn: OAUTH_TICKET_TTL_S,
    });
    return {
      redirect: `${webapp}/mcp/authorize?ticket=${encodeURIComponent(signed)}`,
    };
  }

  private async readTicket(ticket: unknown): Promise<AuthorizeTicket> {
    if (typeof ticket !== 'string' || !ticket)
      throw new NotFoundException('This sign-in link is not valid.');
    try {
      return await this.jwt.verifyAsync<AuthorizeTicket>(ticket, {
        audience: OAUTH_TICKET_AUDIENCE,
      });
    } catch {
      throw new NotFoundException(
        'This sign-in link has expired. Start again from your app.',
      );
    }
  }

  private blockedReason(
    user: IJwtStaffPayload,
  ): 'no_tile' | 'impersonating' | null {
    if (user.impersonatorId) return 'impersonating';
    if (!mayUseMcp(user)) return 'no_tile';
    return null;
  }

  /** What the consent screen shows the signed-in person. */
  async describeConsent(ticketValue: unknown, user: IJwtStaffPayload) {
    const t = await this.readTicket(ticketValue);
    const client = await this.prisma.mcp_oauth_clients.findUnique({
      where: { id: t.cid },
    });
    if (!client)
      throw new NotFoundException(
        'This app is no longer registered. Start again from your app.',
      );
    const blocked = this.blockedReason(user);
    return {
      client: {
        id: client.id,
        name: client.client_name,
        uri: client.client_uri,
        redirect_host: hostOf(t.ru),
      },
      acting_as: { username: user.username, full_name: user.fullName ?? null },
      scope: t.sc,
      allowed: blocked === null,
      blocked_reason: blocked,
      tools: blocked
        ? []
        : this.mcp.listTools(user).map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
          })),
    };
  }

  /**
   * The person's answer. Returns where the browser goes next (back to the
   * client). The `iss` it carries comes from the ticket: this call arrives
   * through the webapp's proxy, whose host is not the issuer (RFC 9207).
   */
  async decideConsent(
    ticketValue: unknown,
    decision: 'approve' | 'deny',
    user: IJwtStaffPayload,
  ) {
    const t = await this.readTicket(ticketValue);
    const client = await this.prisma.mcp_oauth_clients.findUnique({
      where: { id: t.cid },
    });
    if (!client || !redirectUriMatches(t.ru, client.redirect_uris)) {
      throw new NotFoundException(
        'This app is no longer registered. Start again from your app.',
      );
    }
    const iss = t.iss;
    if (decision === 'deny') {
      await this.audit(
        auditActorLabel(user),
        client.id,
        'CONSENT_DENY',
        client.client_name,
      );
      return {
        redirect_to: withParams(t.ru, {
          error: 'access_denied',
          error_description: 'The request was denied',
          state: t.st,
          iss,
        }),
      };
    }
    const blocked = this.blockedReason(user);
    if (blocked === 'impersonating')
      throw new ForbiddenException(
        'An app cannot be connected while impersonating another user.',
      );
    if (blocked === 'no_tile')
      throw new ForbiddenException(
        'Your access does not include the AI Assistant (MCP).',
      );

    const code = newToken(OAUTH_CODE_PREFIX);
    await this.prisma.mcp_oauth_codes.create({
      data: {
        code_hash: hashOAuthSecret(code),
        client_id: client.id,
        user_id: user.sub,
        redirect_uri: t.ru,
        code_challenge: t.cc,
        scope: t.sc,
        resource: t.rs ?? null,
        expires_at: new Date(Date.now() + OAUTH_CODE_TTL_MS),
      },
    });
    await this.audit(
      auditActorLabel(user),
      client.id,
      'CONSENT_APPROVE',
      client.client_name,
    );
    return { redirect_to: withParams(t.ru, { code, state: t.st, iss }) };
  }

  // ── Token ────────────────────────────────────────────────────────────────

  async token(
    body: Record<string, unknown>,
    req: Request,
  ): Promise<TokenResponse> {
    const grantType = str(body.grant_type);
    if (grantType === 'authorization_code') return this.exchangeCode(body, req);
    if (grantType === 'refresh_token') return this.refresh(body);
    throw new OAuthError(
      'unsupported_grant_type',
      'grant_type must be authorization_code or refresh_token',
    );
  }

  private async exchangeCode(
    body: Record<string, unknown>,
    req: Request,
  ): Promise<TokenResponse> {
    const code = body.code;
    const clientId = str(body.client_id);
    if (!hasShape(code, OAUTH_CODE_PREFIX))
      throw new OAuthError('invalid_grant', 'Invalid authorization code');
    if (!clientId)
      throw new OAuthError('invalid_request', 'client_id is required');

    const row = await this.prisma.mcp_oauth_codes.findUnique({
      where: { code_hash: hashOAuthSecret(code) },
      include: { client: true, users: { select: STAFF_USER_SELECT } },
    });
    if (!row)
      throw new OAuthError('invalid_grant', 'Invalid authorization code');
    if (row.used_at) {
      // A replayed code: whoever holds it is not the client that redeemed it.
      if (row.grant_id)
        await this.revokeGrantById(row.grant_id, 'code_reuse', 'system');
      throw new OAuthError('invalid_grant', 'Authorization code already used');
    }
    if (row.expires_at.getTime() <= Date.now())
      throw new OAuthError('invalid_grant', 'Authorization code expired');
    if (row.client_id !== clientId)
      throw new OAuthError(
        'invalid_grant',
        'Code was issued to another client',
      );
    if (str(body.redirect_uri) !== row.redirect_uri)
      throw new OAuthError('invalid_grant', 'redirect_uri does not match');
    if (!verifyPkce(body.code_verifier, row.code_challenge))
      throw new OAuthError('invalid_grant', 'PKCE verification failed');
    const resource = str(body.resource);
    if (
      resource &&
      !sameResource(resource, row.resource ?? this.resourceUrl(req))
    ) {
      throw new OAuthError(
        'invalid_target',
        'resource does not match the authorization request',
      );
    }

    const claimed = await this.prisma.mcp_oauth_codes.updateMany({
      where: { id: row.id, used_at: null },
      data: { used_at: new Date() },
    });
    if (claimed.count !== 1)
      throw new OAuthError('invalid_grant', 'Authorization code already used');

    const user = await this.liveOrRefuse(row.users);
    const now = new Date();
    const grant = await this.prisma.mcp_oauth_grants.create({
      data: {
        client_id: row.client_id,
        user_id: row.user_id,
        scope: row.scope,
        expires_at: new Date(now.getTime() + OAUTH_GRANT_TTL_MS),
        last_used_at: now,
      },
    });
    await this.prisma.mcp_oauth_codes.update({
      where: { id: row.id },
      data: { grant_id: grant.id },
    });
    const issued = await this.issueTokens(
      grant,
      row.user_id,
      row.client.client_name,
      now,
    );
    await this.audit(
      auditActorLabel(user),
      grant.id,
      'TOKEN_ISSUE',
      `${row.client.client_name} (grant until ${grant.expires_at.toISOString().slice(0, 10)})`,
    );
    return issued;
  }

  private async refresh(body: Record<string, unknown>): Promise<TokenResponse> {
    const presented = body.refresh_token;
    const clientId = str(body.client_id);
    if (!hasShape(presented, OAUTH_REFRESH_PREFIX))
      throw new OAuthError('invalid_grant', 'Invalid refresh token');
    if (!clientId)
      throw new OAuthError('invalid_request', 'client_id is required');

    const row = await this.prisma.mcp_oauth_refresh_tokens.findUnique({
      where: { token_hash: hashOAuthSecret(presented) },
      include: {
        grant: {
          include: { client: true, users: { select: STAFF_USER_SELECT } },
        },
      },
    });
    if (!row) throw new OAuthError('invalid_grant', 'Invalid refresh token');
    const grant = row.grant;
    if (grant.client_id !== clientId)
      throw new OAuthError(
        'invalid_grant',
        'Refresh token was issued to another client',
      );
    if (row.used_at) {
      // Rotation means a used refresh token is never legitimately presented again.
      await this.revokeGrantById(grant.id, 'refresh_reuse', 'system');
      throw new OAuthError(
        'invalid_grant',
        'Refresh token already used; the connection has been revoked',
      );
    }
    const now = new Date();
    if (grant.revoked_at)
      throw new OAuthError('invalid_grant', 'This connection was revoked');
    if (grant.expires_at <= now || row.expires_at <= now)
      throw new OAuthError('invalid_grant', 'Refresh token expired');

    const claimed = await this.prisma.mcp_oauth_refresh_tokens.updateMany({
      where: { id: row.id, used_at: null },
      data: { used_at: now },
    });
    if (claimed.count !== 1) {
      await this.revokeGrantById(grant.id, 'refresh_reuse', 'system');
      throw new OAuthError(
        'invalid_grant',
        'Refresh token already used; the connection has been revoked',
      );
    }

    const user = await this.liveOrRefuse(grant.users);
    const issued = await this.issueTokens(
      grant,
      grant.user_id,
      grant.client.client_name,
      now,
    );
    // Keep the table small: access tokens of this grant that expired a day ago are dead weight.
    await this.prisma.mcp_access_tokens.deleteMany({
      where: {
        grant_id: grant.id,
        expires_at: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
    });
    await this.audit(
      auditActorLabel(user),
      grant.id,
      'TOKEN_REFRESH',
      grant.client.client_name,
    );
    return issued;
  }

  /** Re-check the person now: an inactive account or a lost tile ends the connection. */
  private async liveOrRefuse(u: StaffUserRow): Promise<IJwtStaffPayload> {
    let user: IJwtStaffPayload;
    try {
      user = await this.tokens.livePrincipal(u);
    } catch {
      throw new OAuthError(
        'invalid_grant',
        'This account can no longer sign in',
      );
    }
    if (!mayUseMcp(user))
      throw new OAuthError(
        'invalid_grant',
        'This account no longer has the AI Assistant (MCP)',
      );
    return user;
  }

  private async issueTokens(
    grant: { id: string; expires_at: Date; scope: string },
    userId: string,
    clientName: string,
    now: Date,
  ): Promise<TokenResponse> {
    const access = newToken(OAUTH_ACCESS_PREFIX);
    const refresh = newToken(OAUTH_REFRESH_PREFIX);
    const accessExpires = earliest(
      new Date(now.getTime() + OAUTH_ACCESS_TTL_MS),
      grant.expires_at,
    );
    await this.prisma.mcp_access_tokens.create({
      data: {
        user_id: userId,
        grant_id: grant.id,
        name: clientName.slice(0, 100),
        token_prefix: displayPrefix(access),
        token_hash: hashOAuthSecret(access),
        expires_at: accessExpires,
      },
    });
    await this.prisma.mcp_oauth_refresh_tokens.create({
      data: {
        grant_id: grant.id,
        token_hash: hashOAuthSecret(refresh),
        expires_at: earliest(
          new Date(now.getTime() + OAUTH_REFRESH_TTL_MS),
          grant.expires_at,
        ),
      },
    });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: Math.max(
        1,
        Math.floor((accessExpires.getTime() - now.getTime()) / 1000),
      ),
      refresh_token: refresh,
      scope: grant.scope,
    };
  }

  // ── Revocation ───────────────────────────────────────────────────────────

  /**
   * RFC 7009. Presenting a refresh or OAuth access token revokes its whole
   * grant; presenting a personal token revokes that token. Always answers
   * 200, whether or not the token was known.
   */
  async revokeToken(body: Record<string, unknown>): Promise<void> {
    const token = str(body.token);
    if (!token) return;
    const hash = hashOAuthSecret(token);
    if (token.startsWith(OAUTH_REFRESH_PREFIX)) {
      const row = await this.prisma.mcp_oauth_refresh_tokens.findUnique({
        where: { token_hash: hash },
      });
      if (row)
        await this.revokeGrantById(row.grant_id, 'client_revoked', 'system');
      return;
    }
    const row = await this.prisma.mcp_access_tokens.findUnique({
      where: { token_hash: hash },
    });
    if (!row) return;
    if (row.grant_id)
      await this.revokeGrantById(row.grant_id, 'client_revoked', 'system');
    else if (!row.revoked_at) {
      await this.prisma.mcp_access_tokens.update({
        where: { id: row.id },
        data: { revoked_at: new Date() },
      });
    }
  }

  // ── The person's connected apps ──────────────────────────────────────────

  async listGrants(user: IJwtStaffPayload) {
    const rows = await this.prisma.mcp_oauth_grants.findMany({
      where: { user_id: user.sub },
      select: GRANT_LIST_SELECT,
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    const now = Date.now();
    return rows.map(({ client, ...g }) => ({
      ...g,
      client_id: client.id,
      client_name: client.client_name,
      client_uri: client.client_uri,
      redirect_hosts: [...new Set(client.redirect_uris.map(hostOf))],
      status: g.revoked_at
        ? 'revoked'
        : g.expires_at.getTime() <= now
          ? 'expired'
          : 'active',
    }));
  }

  async revokeGrant(user: IJwtStaffPayload, id: string) {
    const grant = await this.prisma.mcp_oauth_grants.findFirst({
      where: { id, user_id: user.sub },
      select: { id: true },
    });
    if (!grant) throw new NotFoundException('Connection not found');
    await this.revokeGrantById(id, 'user_revoked', auditActorLabel(user));
    return (await this.listGrants(user)).find((g) => g.id === id);
  }

  /** Revoke a grant and everything it issued. Idempotent. */
  private async revokeGrantById(id: string, reason: string, actor: string) {
    const now = new Date();
    const updated = await this.prisma.mcp_oauth_grants.updateMany({
      where: { id, revoked_at: null },
      data: { revoked_at: now, revoked_reason: reason },
    });
    await this.prisma.mcp_access_tokens.updateMany({
      where: { grant_id: id, revoked_at: null },
      data: { revoked_at: now },
    });
    await this.prisma.mcp_oauth_refresh_tokens.updateMany({
      where: { grant_id: id, used_at: null },
      data: { used_at: now },
    });
    if (updated.count > 0) await this.audit(actor, id, 'GRANT_REVOKE', reason);
  }

  private async audit(
    actor: string,
    entityId: string,
    action: string,
    value: string,
  ) {
    await this.auditLogs.log({
      entity_type: MCP_OAUTH_ENTITY,
      entity_id: entityId.slice(0, 50),
      action,
      section: 'system',
      new_value: value.slice(0, 500),
      changed_by: actor,
    });
  }
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri.slice(0, 100);
  }
}
