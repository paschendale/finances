import { McpServer } from '@modelcontextprotocol/server';
import { registerAllTools } from './tools/register';
import type { ToolCtx } from './types';

export function createServer(ctx: ToolCtx): McpServer {
  const server = new McpServer({ name: 'finances', version: '1.0.0' });
  registerAllTools(server, ctx);
  return server;
}
