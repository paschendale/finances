import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { callRpc, getView, op } from '../postgrest-client';
import { runTool } from '../tool-result';
import type { ToolCtx } from '../types';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export function registerBudgetTools(server: McpServer, ctx: ToolCtx) {
  server.registerTool(
    'create_budget_plan',
    {
      title: 'Create Budget Plan',
      description: 'Create a new budget plan and set it as the current plan (all other plans become non-current).',
      inputSchema: z.object({
        name: z.string().min(1),
        period_start: dateSchema,
        period_end: dateSchema,
      }),
    },
    async ({ name, period_start, period_end }) =>
      runTool(() =>
        callRpc(ctx, 'create_budget_plan', {
          p_name: name,
          p_period_start: period_start,
          p_period_end: period_end,
        })
      )
  );

  server.registerTool(
    'set_current_budget_plan',
    {
      title: 'Set Current Budget Plan',
      description: 'Switch the active budget plan.',
      inputSchema: z.object({ plan_id: z.string().uuid() }),
    },
    async ({ plan_id }) => runTool(() => callRpc(ctx, 'set_current_budget_plan', { p_plan_id: plan_id }))
  );

  server.registerTool(
    'upsert_budget_item',
    {
      title: 'Upsert Budget Item',
      description: 'Insert or update a budget item for a (plan_id, account_id) pair. The account must be of type expense.',
      inputSchema: z.object({
        plan_id: z.string().uuid(),
        account_id: z.string().uuid(),
        period_amount: z.number(),
        min_pct: z.number(),
        max_pct: z.number(),
        sort_order: z.number().int().default(0),
        category_type: z.enum(['yearly', 'monthly']).default('yearly'),
      }),
    },
    async ({ plan_id, account_id, period_amount, min_pct, max_pct, sort_order, category_type }) =>
      runTool(() =>
        callRpc(ctx, 'upsert_budget_item', {
          p_plan_id: plan_id,
          p_account_id: account_id,
          p_period_amount: period_amount,
          p_min_pct: min_pct,
          p_max_pct: max_pct,
          p_sort_order: sort_order,
          p_category_type: category_type,
        })
      )
  );

  server.registerTool(
    'delete_budget_item',
    {
      title: 'Delete Budget Item',
      description: 'Remove a budget item from a plan.',
      inputSchema: z.object({ id: z.string().uuid() }),
    },
    async ({ id }) => runTool(() => callRpc(ctx, 'delete_budget_item', { p_id: id }))
  );

  server.registerTool(
    'list_budget_items',
    {
      title: 'List Budget Items',
      description: "Budget items for a plan, joined with each account's hierarchical name, icon, and color.",
      inputSchema: z.object({ plan_id: z.string().uuid() }),
    },
    async ({ plan_id }) =>
      runTool(() => getView(ctx, 'budget_items_with_accounts', new URLSearchParams({ plan_id: op.eq(plan_id) })))
  );

  server.registerTool(
    'list_budget_monthly_spending',
    {
      title: 'List Budget Monthly Spending',
      description: 'Actual spending per calendar month within a budget plan period, rolled up per budget item account and its descendants.',
      inputSchema: z.object({ plan_id: z.string().uuid() }),
    },
    async ({ plan_id }) =>
      runTool(() => getView(ctx, 'budget_monthly_spending', new URLSearchParams({ plan_id: op.eq(plan_id) })))
  );
}
