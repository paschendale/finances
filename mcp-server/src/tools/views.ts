import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { getView, op } from '../postgrest-client';
import { runTool } from '../tool-result';
import type { ToolCtx } from '../types';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export function registerViewTools(server: McpServer, ctx: ToolCtx) {
  server.registerTool(
    'list_account_balances',
    {
      title: 'List Account Balances',
      description: 'Current balance for every account, derived from ledger entries.',
      inputSchema: z.object({}),
    },
    async () => runTool(() => getView(ctx, 'account_balances'))
  );

  server.registerTool(
    'get_category_totals',
    {
      title: 'Get Category Totals',
      description: 'Sum of entries per expense/income category, ordered by total descending.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(10) }),
    },
    async ({ limit }) =>
      runTool(() => {
        const params = new URLSearchParams({ order: 'total.desc', limit: String(limit) });
        return getView(ctx, 'category_totals', params);
      })
  );

  server.registerTool(
    'get_dashboard_data',
    {
      title: 'Get Dashboard Data',
      description: 'Flat stream of entries with hierarchical account names, optionally filtered by date range. Used for spending/income aggregation.',
      inputSchema: z.object({ start_date: dateSchema.optional(), end_date: dateSchema.optional() }),
    },
    async ({ start_date, end_date }) =>
      runTool(() => {
        const params = new URLSearchParams();
        if (start_date) params.append('date', op.gte(start_date));
        if (end_date) params.append('date', op.lte(end_date));
        return getView(ctx, 'dashboard_data', params);
      })
  );

  server.registerTool(
    'get_daily_balances',
    {
      title: 'Get Daily Balances',
      description: 'Daily cumulative balance snapshots per asset sub-type (checking, emergency, investments, credit_card, total_assets).',
      inputSchema: z.object({}),
    },
    async () => runTool(() => getView(ctx, 'daily_balances', new URLSearchParams({ order: 'date.asc' })))
  );

  server.registerTool(
    'list_daily_account_balances',
    {
      title: 'List Daily Account Balances',
      description: 'Daily balance per individual account (granular version of get_daily_balances). Optionally filter by dates and/or account_ids.',
      inputSchema: z.object({
        dates: z.array(dateSchema).optional(),
        account_ids: z.array(z.string().uuid()).optional(),
      }),
    },
    async ({ dates, account_ids }) =>
      runTool(() => {
        const params = new URLSearchParams();
        if (dates && dates.length > 0) params.append('date', op.inList(dates));
        if (account_ids && account_ids.length > 0) params.append('account_id', op.inList(account_ids));
        return getView(ctx, 'daily_account_balances', params);
      })
  );

  server.registerTool(
    'get_monthly_balances',
    {
      title: 'Get Monthly Balances',
      description: 'Monthly balance snapshots.',
      inputSchema: z.object({}),
    },
    async () => runTool(() => getView(ctx, 'monthly_balances'))
  );

  server.registerTool(
    'list_accounts_hierarchical',
    {
      title: 'List Accounts Hierarchical',
      description: 'All accounts with their full hierarchical name computed (e.g. expenses:food:grocery).',
      inputSchema: z.object({}),
    },
    async () => runTool(() => getView(ctx, 'account_names_hierarchical'))
  );

  server.registerTool(
    'list_account_usage',
    {
      title: 'List Account Usage',
      description: 'Accounts ranked by how often they appear in entries, most-used first.',
      inputSchema: z.object({}),
    },
    async () => runTool(() => getView(ctx, 'account_usage', new URLSearchParams({ order: 'usage_count.desc' })))
  );

  server.registerTool(
    'list_description_memories',
    {
      title: 'List Description Memories',
      description: 'Remembered transaction descriptions joined with their suggested account names, most recently used first.',
      inputSchema: z.object({}),
    },
    async () => runTool(() => getView(ctx, 'description_memories_with_names', new URLSearchParams({ order: 'updated_at.desc' })))
  );
}
