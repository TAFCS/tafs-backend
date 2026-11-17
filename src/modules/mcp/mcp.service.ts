import { HttpException, Injectable, Logger, Type } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { CaslAbilityFactory } from '../auth/casl/casl-ability.factory';
import type { IJwtStaffPayload } from '../auth/interfaces/jwt-payload.interface';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { auditActorLabel } from '../../common/utils/audit-actor.util';
import { McpRouteAccess } from './mcp-access';
import {
  MCP_TOOLS,
  MCP_TOOLS_BY_NAME,
  McpToolDef,
  McpToolDeps,
  unwrap,
} from './mcp-tools';
import { capResult, serializeResult, summarizeArgs } from './mcp-result';
import { MCP_TOOL_ENTITY } from './mcp.constants';

export const MCP_SERVER_NAME = 'tafs-admin';
export const MCP_SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = [
  'TAFS school management system, read-only.',
  'A student is identified by CC (their id); GR number is the school register number.',
  'Every answer is limited to what your TAFS account may see: your tiles decide which tools exist and your scope decides which campuses, classes and sections show up.',
  'Arrears always come from get_student_arrears or list_defaulters; do not add up voucher balances yourself.',
  'Amounts are Pakistani rupees. Call whoami to see your role, scope and tools.',
].join(' ');

export type McpCallOutcome = 'CALL' | 'DENIED' | 'ERROR';

/**
 * The admin MCP server (TAFSD-531). Stateless: each HTTP request builds a
 * server for the caller, answers one JSON-RPC message and is discarded, so
 * the tool list always reflects the caller's access at that moment.
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly access: McpRouteAccess;
  private readonly deps: McpToolDeps;

  constructor(
    private readonly moduleRef: ModuleRef,
    reflector: Reflector,
    abilityFactory: CaslAbilityFactory,
    private readonly auditLogs: AuditLogsService,
  ) {
    this.access = new McpRouteAccess(reflector, abilityFactory);
    this.deps = {
      controller: <T>(cls: Type<T>): T =>
        this.moduleRef.get(cls, { strict: false }),
    };
  }

  /** Whether `user` may see and call `tool` right now. */
  canUse(tool: McpToolDef, user: IJwtStaffPayload): boolean {
    return tool.route === null || this.access.allows(tool.route, user);
  }

  visibleTools(user: IJwtStaffPayload): McpToolDef[] {
    return MCP_TOOLS.filter((t) => this.canUse(t, user));
  }

  listTools(user: IJwtStaffPayload): Tool[] {
    return this.visibleTools(user).map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: {
        title: t.title,
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    }));
  }

  /**
   * Run one tool for `user`. Access is decided again here, never taken from
   * an earlier tools/list: a tool the caller may not use is reported exactly
   * like one that does not exist.
   */
  async callTool(
    user: IJwtStaffPayload,
    name: string,
    args: Record<string, unknown> | undefined,
    tokenId: string | null,
  ): Promise<CallToolResult> {
    const input = args ?? {};
    const tool = MCP_TOOLS_BY_NAME.get(name);
    if (!tool || !this.canUse(tool, user)) {
      await this.audit(
        user,
        name,
        'DENIED',
        input,
        tokenId,
        tool ? 'not permitted' : 'unknown tool',
      );
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }

    try {
      const data =
        tool.name === 'whoami'
          ? this.whoami(user)
          : unwrap(await tool.run(this.deps, input, user));
      const { text, truncated } = capResult(serializeResult(data));
      await this.audit(
        user,
        name,
        'CALL',
        input,
        tokenId,
        `ok, ${text.length} chars${truncated ? ' (truncated)' : ''}`,
      );
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      if (err instanceof HttpException) {
        const body = err.getResponse();
        const message =
          typeof body === 'object' && body && 'message' in body
            ? ([] as unknown[])
                .concat((body as { message: unknown }).message)
                .join('; ')
            : err.message;
        await this.audit(
          user,
          name,
          'ERROR',
          input,
          tokenId,
          `${err.getStatus()}: ${message}`.slice(0, 300),
        );
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
      this.logger.error(
        `MCP tool ${name} failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      await this.audit(user, name, 'ERROR', input, tokenId, 'internal error');
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'The tool failed. Try again or narrow the query.',
          },
        ],
      };
    }
  }

  private whoami(user: IJwtStaffPayload) {
    return {
      username: user.username,
      full_name: user.fullName ?? null,
      role: user.role,
      home_campus_id: user.campusId,
      scope: user.scope ?? null,
      scope_note: 'An empty list means no restriction on that dimension.',
      tools: this.visibleTools(user).map((t) => t.name),
    };
  }

  private async audit(
    user: IJwtStaffPayload,
    tool: string,
    outcome: McpCallOutcome,
    args: Record<string, unknown>,
    tokenId: string | null,
    result: string,
  ) {
    await this.auditLogs.log({
      entity_type: MCP_TOOL_ENTITY,
      entity_id: tool.slice(0, 100),
      action: outcome,
      section: 'system',
      new_value: result,
      note: `args ${summarizeArgs(args)}${tokenId ? ` · token ${tokenId}` : ''}`,
      changed_by: auditActorLabel(user),
    });
  }

  /** A fresh MCP server bound to one caller. */
  buildServer(user: IJwtStaffPayload, tokenId: string | null): Server {
    const server = new Server(
      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      {
        capabilities: { tools: { listChanged: false } },
        instructions: INSTRUCTIONS,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.listTools(user),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.callTool(
        user,
        request.params.name,
        request.params.arguments,
        tokenId,
      ),
    );
    return server;
  }

  /** Answer one Streamable HTTP POST for an authenticated caller. */
  async handle(
    req: Request,
    res: Response,
    user: IJwtStaffPayload,
    tokenId: string | null,
  ): Promise<void> {
    const server = this.buildServer(user, tokenId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}
