import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpOAuthService } from './oauth.service';

/**
 * TAFSD-531: OAuth discovery documents, at the backend origin root (outside
 * the /api/v1 prefix, see main.ts). Clients find the protected-resource
 * metadata from the 401 of /api/v1/mcp, and the authorization server from it.
 */
@Controller('.well-known')
export class McpWellKnownController {
  constructor(private readonly oauth: McpOAuthService) {}

  private send(res: Response, body: unknown) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(body);
  }

  @Get('oauth-protected-resource')
  protectedResource(@Req() req: Request, @Res() res: Response) {
    this.send(res, this.oauth.protectedResourceMetadata(req));
  }

  /** RFC 9728 path-aware form for the resource /api/v1/mcp. */
  @Get('oauth-protected-resource/api/v1/mcp')
  protectedResourceForPath(@Req() req: Request, @Res() res: Response) {
    this.send(res, this.oauth.protectedResourceMetadata(req));
  }

  @Get('oauth-authorization-server')
  authorizationServer(@Req() req: Request, @Res() res: Response) {
    this.send(res, this.oauth.authorizationServerMetadata(req));
  }
}
