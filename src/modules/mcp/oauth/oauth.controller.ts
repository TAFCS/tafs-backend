import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { JwtStaffGuard } from '../../../common/guards/jwt-staff.guard';
import { CurrentUser } from '../../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../../utils/serializer.util';
import { McpOAuthService, OAuthError } from './oauth.service';

export class ConsentDecisionDto {
  @IsString()
  @IsNotEmpty()
  ticket: string;

  @IsIn(['approve', 'deny'])
  decision: 'approve' | 'deny';
}

/** OAuth answers carry no caching and the RFC 6749 error shape, never the app's response envelope. */
function sendOAuth(res: Response, status: number, body: unknown) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.status(status).json(body);
}

function sendOAuthError(res: Response, err: unknown) {
  if (err instanceof OAuthError) {
    if (err.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    return sendOAuth(res, err.status, err.toJSON());
  }
  throw err;
}

/** A minimal page for authorize errors that must not be redirected (unknown client or redirect URI). */
function errorPage(message: string): string {
  const safe = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TAFS sign-in</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#18181b"><h1 style="font-size:1.25rem">Cannot connect this app</h1><p>${safe}</p></body></html>`;
}

/**
 * TAFSD-531: OAuth 2.1 endpoints for the admin MCP server. Registration,
 * authorize, token and revoke are public (that is the protocol); the consent
 * pair is for the signed-in person in the webapp.
 */
@Controller('mcp/oauth')
export class McpOAuthController {
  constructor(private readonly oauth: McpOAuthService) {}

  @Post('register')
  async register(@Body() body: Record<string, unknown>, @Res() res: Response) {
    try {
      sendOAuth(res, HttpStatus.CREATED, await this.oauth.register(body ?? {}));
    } catch (err) {
      sendOAuthError(res, err);
    }
  }

  @Get('authorize')
  async authorize(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const result = await this.oauth.authorize(query ?? {}, req);
    res.setHeader('Cache-Control', 'no-store');
    if ('redirect' in result)
      return res.redirect(HttpStatus.FOUND, result.redirect);
    res.status(result.status).type('html').send(errorPage(result.message));
  }

  @Post('token')
  async token(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      sendOAuth(res, HttpStatus.OK, await this.oauth.token(body ?? {}, req));
    } catch (err) {
      sendOAuthError(res, err);
    }
  }

  @Post('revoke')
  async revoke(@Body() body: Record<string, unknown>, @Res() res: Response) {
    await this.oauth.revokeToken(body ?? {});
    sendOAuth(res, HttpStatus.OK, {});
  }

  /** The consent screen's content, for the signed-in person. */
  @Get('consent')
  @UseGuards(JwtStaffGuard)
  async consent(
    @Query('ticket') ticket: string,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return createApiResponse(
      await this.oauth.describeConsent(ticket, user),
      HttpStatus.OK,
      'Consent request',
    );
  }

  /** Approve or deny. Answers where the browser goes next; the page navigates there. */
  @Post('consent')
  @UseGuards(JwtStaffGuard)
  async decide(
    @Body() dto: ConsentDecisionDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return createApiResponse(
      await this.oauth.decideConsent(dto.ticket, dto.decision, user),
      HttpStatus.OK,
      dto.decision === 'approve' ? 'App connected' : 'Request denied',
    );
  }
}
