import type { McpServer } from '@modelcontextprotocol/server';
import { registerTransactionTools } from './transactions';
import { registerLookupTools } from './lookups';
import { registerViewTools } from './views';
import { registerBudgetTools } from './budget';
import type { ToolCtx } from '../types';

export function registerAllTools(server: McpServer, ctx: ToolCtx): void {
  registerTransactionTools(server, ctx);
  registerLookupTools(server, ctx);
  registerViewTools(server, ctx);
  registerBudgetTools(server, ctx);
}

export const EXPECTED_TOOL_NAMES = [
  'create_transaction',
  'update_transaction',
  'delete_transaction',
  'list_transactions',
  'match_account',
  'match_description_memory',
  'list_account_balances',
  'get_category_totals',
  'get_dashboard_data',
  'get_daily_balances',
  'list_daily_account_balances',
  'get_monthly_balances',
  'list_accounts_hierarchical',
  'list_account_usage',
  'list_description_memories',
  'create_budget_plan',
  'set_current_budget_plan',
  'upsert_budget_item',
  'delete_budget_item',
  'list_budget_items',
  'list_budget_monthly_spending',
] as const;
