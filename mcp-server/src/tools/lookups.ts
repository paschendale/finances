import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { callRpc } from '../postgrest-client';
import { runTool } from '../tool-result';
import type { ToolCtx } from '../types';

export function registerLookupTools(server: McpServer, ctx: ToolCtx) {
  server.registerTool(
    'match_account',
    {
      title: 'Match Account',
      description: 'Fuzzy-match a text string against account names. Use to resolve an account name/description to an account_id before creating a transaction.',
      inputSchema: z.object({ input: z.string().min(1) }),
    },
    async ({ input }) => runTool(() => callRpc(ctx, 'match_account', { p_input: input }))
  );

  server.registerTool(
    'match_description_memory',
    {
      title: 'Match Description Memory',
      description: 'Fuzzy-match a description string against remembered past transaction descriptions, returning suggested category/account/currency.',
      inputSchema: z.object({ input: z.string().min(1) }),
    },
    async ({ input }) => runTool(() => callRpc(ctx, 'match_description_memory', { p_input: input }))
  );
}
