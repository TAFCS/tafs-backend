import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { McpTokensService } from './mcp-tokens.service';
import { CreateMcpTokenDto } from './dto/create-mcp-token.dto';
import { MCP_USE_ACTION } from './mcp.constants';
import { McpOAuthService } from './oauth/oauth.service';
import { MCP_RESOURCE_PATH } from './oauth/oauth.util';

/**
 * A person's own MCP access tokens (TAFSD-531). Everyone manages only their
 * own; holding the AI Assistant tile is what lets them have any.
 */
@Controller('mcp/tokens')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
@RequireAction(MCP_USE_ACTION)
export class McpTokensController {
  constructor(
    private readonly tokens: McpTokensService,
    private readonly oauth: McpOAuthService,
  ) {}

  /**
   * The MCP server address people should give their AI client: the public
   * one (MCP_PUBLIC_URL), which sign-in is bound to. The webapp shows this
   * rather than its own API origin, which in production is the platform's
   * internal hostname. endpoint is null when sign-in is not configured.
   */
  @Get('server')
  server(@Req() req: Request) {
    const base = this.oauth.publicBase(req);
    return createApiResponse(
      { endpoint: base ? base + MCP_RESOURCE_PATH : null, sign_in_available: !!base },
      HttpStatus.OK,
      'MCP server address retrieved successfully',
    );
  }

  @Get()
  async list(@CurrentUser() user: IJwtStaffPayload) {
    return createApiResponse(
      await this.tokens.list(user),
      HttpStatus.OK,
      'MCP tokens retrieved successfully',
    );
  }

  @Post()
  async issue(
    @Body() dto: CreateMcpTokenDto,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return createApiResponse(
      await this.tokens.issue(user, dto),
      HttpStatus.CREATED,
      'MCP token issued. Copy it now: it will not be shown again.',
    );
  }

  @Delete(':id')
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return createApiResponse(
      await this.tokens.revoke(user, id),
      HttpStatus.OK,
      'MCP token revoked',
    );
  }
}
