import {
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { JwtStaffGuard } from '../../common/guards/jwt-staff.guard';
import { PoliciesGuard } from '../../common/guards/policies.guard';
import { TileActionGuard } from '../../common/guards/tile-action.guard';
import { RequireAction } from '../../decorators/require-action.decorator';
import { CurrentUser } from '../../decorators/current-user.decorator';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { createApiResponse } from '../../utils/serializer.util';
import { McpOAuthService } from './oauth/oauth.service';
import { MCP_USE_ACTION } from './mcp.constants';

/** A person's own connected apps (OAuth grants), each revocable (TAFSD-531). */
@Controller('mcp/grants')
@UseGuards(JwtStaffGuard, PoliciesGuard, TileActionGuard)
@RequireAction(MCP_USE_ACTION)
export class McpGrantsController {
  constructor(private readonly oauth: McpOAuthService) {}

  @Get()
  async list(@CurrentUser() user: IJwtStaffPayload) {
    return createApiResponse(
      await this.oauth.listGrants(user),
      HttpStatus.OK,
      'Connected apps retrieved successfully',
    );
  }

  @Delete(':id')
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: IJwtStaffPayload,
  ) {
    return createApiResponse(
      await this.oauth.revokeGrant(user, id),
      HttpStatus.OK,
      'Connection revoked',
    );
  }
}
