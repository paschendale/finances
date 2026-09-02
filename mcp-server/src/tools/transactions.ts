import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { callRpc, getView, op } from '../postgrest-client';
import { runTool } from '../tool-result';
import type { ToolCtx } from '../types';

const entrySchema = z.object({
  account_id: z.string().uuid(),
  amount: z.number(),
  currency: z.string().length(3),
  exchange_rate: z.number().positive().default(1.0),
  amount_base: z.number(),
});

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export function registerTransactionTools(server: McpServer, ctx: ToolCtx) {
  server.registerTool(
    'create_transaction',
    {
      title: 'Create Transaction',
      description:
        'Create a new ledger transaction with its entries. Entries must have at least 2 items and SUM(amount_base) must equal 0.00 (double-entry invariant).',
      inputSchema: z.object({
        date: dateSchema,
        description: z.string().min(1),
        entries: z.array(entrySchema).min(2),
      }),
    },
    async ({ date, description, entries }) =>
      runTool(() =>
        callRpc(ctx, 'create_transaction', {
          p_date: date,
          p_description: description,
          p_entries: entries,
        })
      )
  );

  server.registerTool(
    'update_transaction',
    {
      title: 'Update Transaction',
      description: 'Replace an existing transaction and its entries. Same balance constraint as create_transaction.',
      inputSchema: z.object({
        id: z.string().uuid(),
        date: dateSchema,
        description: z.string().min(1),
        entries: z.array(entrySchema).min(2),
      }),
    },
    async ({ id, date, description, entries }) =>
      runTool(() =>
        callRpc(ctx, 'update_transaction', {
          p_id: id,
          p_date: date,
          p_description: description,
          p_entries: entries,
        })
      )
  );

  server.registerTool(
    'delete_transaction',
    {
      title: 'Delete Transaction',
      description: 'Delete a transaction and all its entries.',
      inputSchema: z.object({ id: z.string().uuid() }),
    },
    async ({ id }) => runTool(() => callRpc(ctx, 'delete_transaction', { p_id: id }))
  );

  server.registerTool(
    'list_transactions',
    {
      title: 'List Transactions',
      description: 'List transactions with their entries, most recent first. Supports date range, account, and description filters.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
        start_date: dateSchema.optional(),
        end_date: dateSchema.optional(),
        account_ids: z.array(z.string().uuid()).optional(),
        description_search: z.string().optional(),
      }),
    },
    async ({ limit, offset, start_date, end_date, account_ids, description_search }) =>
      runTool(() => {
        const params = new URLSearchParams();
        params.append('order', 'date.desc,created_at.desc');
        params.append('limit', String(limit));
        params.append('offset', String(offset));
        if (start_date) params.append('date', op.gte(start_date));
        if (end_date) params.append('date', op.lte(end_date));
        if (account_ids && account_ids.length > 0) params.append('account_ids', op.overlaps(account_ids));
        if (description_search) params.append('description', op.ilike(description_search));
        return getView(ctx, 'transactions_with_entries', params);
      })
  );
}
