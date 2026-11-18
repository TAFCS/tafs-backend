import {
  All,
  Controller,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { McpTokensService } from './mcp-tokens.service';
import { McpService } from './mcp.service';
import { McpOAuthService } from './oauth/oauth.service';
import { bearerFrom } from './mcp-token.util';

/**
 * The admin MCP endpoint (TAFSD-531): POST /api/v1/mcp, Streamable HTTP,
 * stateless JSON. Authenticated by a personal access token from /mcp/tokens
 * or an OAuth access token from /mcp/oauth/token; the browser session cookie
 * and JWT are not accepted here.
 */
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly tokens: McpTokensService,
    private readonly mcp: McpService,
    private readonly oauth: McpOAuthService,
  ) {}

  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    let session: Awaited<ReturnType<McpTokensService['authenticate']>>;
    try {
      session = await this.tokens.authenticate(
        bearerFrom(req.headers.authorization),
      );
    } catch (err) {
      if (!(err instanceof HttpException)) {
        this.logger.error(
          `MCP authentication failed: ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
      const status =
        err instanceof HttpException
          ? err.getStatus()
          : HttpStatus.UNAUTHORIZED;
      const message =
        err instanceof HttpException ? err.message : 'Unauthorized';
      if (status === HttpStatus.UNAUTHORIZED) {
        // MCP authorization spec: point the client at the protected-resource
        // metadata, which names the authorization server to sign in with.
        const presented = Boolean(req.headers.authorization);
        res.setHeader(
          'WWW-Authenticate',
          `Bearer resource_metadata="${this.oauth.resourceMetadataUrl(req)}"` +
            (presented ? ', error="invalid_token"' : ''),
        );
      }
      res
        .status(status)
        .json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
      return;
    }
    await this.mcp.handle(req, res, session.user, session.credential);
  }

  /** Stateless server: no SSE stream to open (GET) and no session to end (DELETE). */
  @All()
  notAllowed(@Res() res: Response): void {
    res
      .status(HttpStatus.METHOD_NOT_ALLOWED)
      .setHeader('Allow', 'POST')
      .json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      });
  }
}
