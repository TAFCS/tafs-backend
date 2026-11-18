import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
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

/**
 * A person's own MCP access tokens (TAFSD-531). Everyone manages only their
 * own; holding the AI Assistant tile is what lets them have any.
 */
@Controller('mcp/tokens')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
@RequireAction(MCP_USE_ACTION)
export class McpTokensController {
  constructor(private readonly tokens: McpTokensService) {}

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
