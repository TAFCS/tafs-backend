import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { McpController } from './mcp.controller';
import { McpTokensController } from './mcp-tokens.controller';
import { McpTokensService } from './mcp-tokens.service';
import { McpService } from './mcp.service';

/**
 * TAFSD-531: an MCP server for staff AI assistants. Tools call the existing
 * controllers (found through ModuleRef), so this module imports none of their
 * modules and adds no data access of its own beyond its token table.
 */
@Module({
  imports: [AuthModule],
  controllers: [McpTokensController, McpController],
  providers: [McpTokensService, McpService],
})
export class McpModule {}
