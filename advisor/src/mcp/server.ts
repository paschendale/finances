import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { registerLedgerReadTools } from './tools/ledger-read.js';
import { registerAdvisorTools } from './tools/advisor.js';
import type { McpSession } from './tokens.js';
import { scoped } from '../log.js';

const log = scoped('mcp');

export function buildMcpServer(ctx: AppContext, session: McpSession): McpServer {
  const server = new McpServer({ name: 'advisor', version: '1.0.0' });
  registerLedgerReadTools(server, ctx.pg);
  registerAdvisorTools(server, ctx, session);
  return server;
}

/**
 * Local Streamable HTTP MCP endpoint for `claude` sessions. Stateless per request; the bearer
 * token minted per run scopes plan tools to one conversation. Binds to 127.0.0.1 only.
 */
export function createMcpApp(ctx: AppContext): Hono {
  const app = new Hono();
  app.all('/mcp', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const session = token ? ctx.mcpTokens.resolve(token) : null;
    if (!session) return c.text('Unauthorized', 401);
    const server = buildMcpServer(ctx, session);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    // Stateless: the transport lives as long as the response stream; nothing to tear down here.
    return transport.handleRequest(c.req.raw);
  });
  app.get('/healthz', (c) => c.text('ok'));
  return app;
}

export function startMcpServer(ctx: AppContext): ServerType {
  const app = createMcpApp(ctx);
  const server = serve({ fetch: app.fetch, port: ctx.config.MCP_PORT, hostname: '127.0.0.1' }, (info) => {
    log.info({ port: info.port }, 'MCP server listening on 127.0.0.1');
  });
  return server;
}
