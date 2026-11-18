import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpOAuthService, OAuthError } from './oauth.service';

/**
 * TAFSD-531: OAuth discovery documents, at the backend origin root (outside
 * the /api/v1 prefix, see main.ts). Clients find the protected-resource
 * metadata from the 401 of /api/v1/mcp, and the authorization server from it.
 */
@Controller('.well-known')
export class McpWellKnownController {
  constructor(private readonly oauth: McpOAuthService) {}

  /**
   * The documents name URLs derived from MCP_PUBLIC_URL (or, outside
   * production, from the request's host), so they are never cached by a
   * shared cache. Without MCP_PUBLIC_URL in production there is no OAuth:
   * 503, and personal tokens keep working.
   */
  private send(res: Response, build: () => unknown) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Host, X-Forwarded-Host, X-Forwarded-Proto');
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      res.json(build());
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      res.status(err.status).json(err.toJSON());
    }
  }

  @Get('oauth-protected-resource')
  protectedResource(@Req() req: Request, @Res() res: Response) {
    this.send(res, () => this.oauth.protectedResourceMetadata(req));
  }

  /** RFC 9728 path-aware form for the resource /api/v1/mcp. */
  @Get('oauth-protected-resource/api/v1/mcp')
  protectedResourceForPath(@Req() req: Request, @Res() res: Response) {
    this.send(res, () => this.oauth.protectedResourceMetadata(req));
  }

  @Get('oauth-authorization-server')
  authorizationServer(@Req() req: Request, @Res() res: Response) {
    this.send(res, () => this.oauth.authorizationServerMetadata(req));
  }
}
