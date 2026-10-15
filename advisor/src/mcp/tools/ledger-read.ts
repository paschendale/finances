import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { PostgrestClient } from '../../postgrest/client.js';
import { op } from '../../postgrest/client.js';
import { runTool } from '../result.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

/** Read-only ledger tools. Names and shapes mirror mcp-server/ so ADVISOR_PROMPT knowledge carries over. */
export function registerLedgerReadTools(server: McpServer, pg: PostgrestClient): void {
  server.registerTool(
    'list_account_balances',
    {
      title: 'List Account Balances',
      description:
        'Current balance for every visible account (hidden accounts are out of scope), derived from ledger entries. Includes reconciled_through and cleared_balance.',
      inputSchema: z.object({ types: z.array(z.enum(['asset', 'liability', 'expense', 'income', 'equity'])).optional() }),
    },
    async ({ types }) =>
      runTool(() => {
        const params = new URLSearchParams({ hidden: 'is.false', order: 'account_name.asc' });
        if (types && types.length > 0) params.append('account_type', op.inList(types));
        return pg.get('account_balances', params);
      }),
  );

  server.registerTool(
    'list_transactions',
    {
      title: 'List Transactions',
      description:
        'Transactions with their entries, most recent first. Filters: date range, account ids, description search. Each row carries metadata (provenance, statement_line) and clearing (which reconciliation cleared it).',
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
        return pg.get('transactions_with_entries', params);
      }),
  );

  server.registerTool(
    'match_account',
    {
      title: 'Match Account',
      description: 'Fuzzy-match free text (name, alias, bank name) to an account_id. Always resolve accounts this way; never invent ids.',
      inputSchema: z.object({ input: z.string().min(1) }),
    },
    async ({ input }) => runTool(() => pg.rpc('match_account', { p_input: input })),
  );

  server.registerTool(
    'match_description_memory',
    {
      title: 'Match Description Memory',
      description: 'Legacy shape of classify_candidates for a description only. Prefer classify_candidates, which takes amount, account, date and raw text.',
      inputSchema: z.object({ input: z.string().min(1) }),
    },
    async ({ input }) => runTool(() => pg.rpc('match_description_memory', { p_input: input })),
  );

  server.registerTool(
    'get_category_totals',
    {
      title: 'Get Category Totals',
      description: 'Sum of entries per expense/income category, ordered by total descending.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(20) }),
    },
    async ({ limit }) => runTool(() => pg.get('category_totals', new URLSearchParams({ order: 'total.desc', limit: String(limit) }))),
  );

  server.registerTool(
    'get_dashboard_data',
    {
      title: 'Get Dashboard Data',
      description: 'Flat stream of entries with hierarchical account names, optionally filtered by date range. Use for spending/income aggregation.',
      inputSchema: z.object({ start_date: dateSchema.optional(), end_date: dateSchema.optional() }),
    },
    async ({ start_date, end_date }) =>
      runTool(() => {
        const params = new URLSearchParams();
        if (start_date) params.append('date', op.gte(start_date));
        if (end_date) params.append('date', op.lte(end_date));
        return pg.get('dashboard_data', params);
      }),
  );

  server.registerTool(
    'get_daily_balances',
    {
      title: 'Get Daily Balances',
      description: 'Daily cumulative balance per account type plus net_worth. Optional date range.',
      inputSchema: z.object({ start_date: dateSchema.optional(), end_date: dateSchema.optional() }),
    },
    async ({ start_date, end_date }) =>
      runTool(() => {
        const params = new URLSearchParams({ order: 'date.asc' });
        if (start_date) params.append('date', op.gte(start_date));
        if (end_date) params.append('date', op.lte(end_date));
        return pg.get('daily_balances', params);
      }),
  );

  server.registerTool(
    'list_daily_account_balances',
    {
      title: 'List Daily Account Balances',
      description: 'Daily balance per individual account. Filter by dates and/or account_ids (strongly recommended: the full table is large).',
      inputSchema: z.object({
        dates: z.array(dateSchema).optional(),
        account_ids: z.array(z.string().uuid()).optional(),
        start_date: dateSchema.optional(),
        end_date: dateSchema.optional(),
      }),
    },
    async ({ dates, account_ids, start_date, end_date }) =>
      runTool(() => {
        const params = new URLSearchParams({ order: 'date.asc' });
        if (dates && dates.length > 0) params.append('date', op.inList(dates));
        if (start_date) params.append('date', op.gte(start_date));
        if (end_date) params.append('date', op.lte(end_date));
        if (account_ids && account_ids.length > 0) params.append('account_id', op.inList(account_ids));
        return pg.get('daily_account_balances', params);
      }),
  );

  server.registerTool(
    'get_monthly_balances',
    { title: 'Get Monthly Balances', description: 'Monthly balance snapshots per account type.', inputSchema: z.object({}) },
    async () => runTool(() => pg.get('monthly_balances')),
  );

  server.registerTool(
    'list_accounts_hierarchical',
    {
      title: 'List Accounts Hierarchical',
      description:
        'All visible accounts with their full hierarchical name (e.g. alimentacao:basica), type, subtype, parent, balance. Subtypes checking/emergency/investments/liabilities are shown on the dashboard as money; property (a house, a car) and loan (a mortgage) are tracked but not shown as money; null is not grouped.',
      inputSchema: z.object({}),
    },
    async () =>
      runTool(() =>
        pg.get('account_balances', new URLSearchParams({ select: 'id:account_id,full_name:account_name,type:account_type,subtype,parent_id,balance,last_checked', hidden: 'is.false', order: 'account_name.asc' })),
      ),
  );

  server.registerTool(
    'list_account_usage',
    { title: 'List Account Usage', description: 'Accounts ranked by how often they appear in entries, most-used first.', inputSchema: z.object({}) },
    async () => runTool(() => pg.get('account_usage', new URLSearchParams({ order: 'usage_count.desc' }))),
  );

  server.registerTool(
    'list_description_memories',
    {
      title: 'List Description Memories',
      description: 'Derived list of known descriptions with their dominant category and account, most recently used first. Derived from transactions, not stored.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(2000).default(300), search: z.string().optional() }),
    },
    async ({ limit, search }) =>
      runTool(() => {
        const params = new URLSearchParams({ order: 'updated_at.desc', limit: String(limit) });
        if (search) params.append('description', op.ilike(search));
        return pg.get('description_memories_with_names', params);
      }),
  );

  server.registerTool(
    'list_budget_plans',
    { title: 'List Budget Plans', description: 'Budget plans (name, period, is_current).', inputSchema: z.object({}) },
    async () => runTool(() => pg.get('budget_plans', new URLSearchParams({ order: 'period_start.desc' }))),
  );

  server.registerTool(
    'list_budget_items',
    {
      title: 'List Budget Items',
      description: "Budget items for a plan, joined with each account's hierarchical name, icon and color.",
      inputSchema: z.object({ plan_id: z.string().uuid() }),
    },
    async ({ plan_id }) => runTool(() => pg.get('budget_items_with_accounts', new URLSearchParams({ plan_id: op.eq(plan_id), order: 'sort_order.asc' }))),
  );

  server.registerTool(
    'list_budget_monthly_spending',
    {
      title: 'List Budget Monthly Spending',
      description: 'Actual spending per calendar month within a budget plan period, rolled up per budget item account and its descendants.',
      inputSchema: z.object({ plan_id: z.string().uuid() }),
    },
    async ({ plan_id }) => runTool(() => pg.get('budget_monthly_spending', new URLSearchParams({ plan_id: op.eq(plan_id), order: 'month.asc' }))),
  );

  server.registerTool(
    'get_category_monthly_history',
    {
      title: 'Get Category Monthly History',
      description: 'Monthly spending history for a category account (and descendants), independent of any budget plan.',
      inputSchema: z.object({ account_id: z.string().uuid(), months: z.number().int().min(1).max(60).default(13) }),
    },
    async ({ account_id, months }) => runTool(() => pg.rpc('get_category_monthly_history', { p_account_id: account_id, p_months: months })),
  );

  server.registerTool(
    'ledger_balance_as_of',
    {
      title: 'Ledger Balance As Of',
      description: 'SUM(amount_base) of an account up to and including a date (own entries only).',
      inputSchema: z.object({ account_id: z.string().uuid(), date: dateSchema }),
    },
    async ({ account_id, date }) => runTool(() => pg.rpc('ledger_balance_as_of', { p_account_id: account_id, p_date: date })),
  );

  server.registerTool(
    'uncleared_entries',
    {
      title: 'Uncleared Entries',
      description: 'Ledger entries on an account not vouched for by any statement reconciliation, up to a date (optionally from a date). Use for outstanding-item analysis.',
      inputSchema: z.object({ account_id: z.string().uuid(), through_date: dateSchema.optional(), from_date: dateSchema.optional() }),
    },
    async ({ account_id, through_date, from_date }) =>
      runTool(() =>
        pg.rpc('uncleared_entries', {
          p_account_id: account_id,
          p_through_date: through_date ?? new Date().toISOString().slice(0, 10),
          p_from_date: from_date ?? null,
        }),
      ),
  );

  server.registerTool(
    'classify_candidates',
    {
      title: 'Classify Candidates',
      description:
        'Ranked category candidates for a transaction line, derived from the ledger history: name similarity, raw statement text, amount, asset account, weekday/day-of-month/hour and recency. Returns score, confidence, n_matches, canonical_description (the household short name) and per-factor evidence. This is the primary categorisation tool.',
      inputSchema: z.object({
        description: z.string().min(1),
        amount: z.number().optional(),
        account_id: z.string().uuid().optional(),
        date: dateSchema.optional(),
        posted_at: z.string().optional(),
        raw: z.string().optional(),
        limit: z.number().int().min(1).max(10).default(5),
      }),
    },
    async ({ description, amount, account_id, date, posted_at, raw, limit }) =>
      runTool(() =>
        pg.rpc('classify_candidates', {
          p_description: description,
          p_amount: amount ?? null,
          p_account_id: account_id ?? null,
          p_date: date ?? null,
          p_posted_at: posted_at ?? null,
          p_raw: raw ?? null,
          p_limit: limit,
        }),
      ),
  );
}
