import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../../context.js';
import type { McpSession } from '../tokens.js';
import { runTool } from '../result.js';
import { many, maybeOne } from '../../db/client.js';
import { getStatement } from '../../db/repo/statements.js';
import { addNote, listNotes } from '../../db/repo/misc.js';
import { createPlan, getPlan, listPlanItems, replacePlanItems, updatePlan } from '../../db/repo/plans.js';
import { getConversation, updateConversation } from '../../db/repo/conversations.js';
import { planItemInputSchema, validatePlanItems } from '../../plan/schema.js';
import { computePlanBalance, ensureStatementAccount, loadAccounts, reconciliationDetail, reconciliationHistory } from '../../plan/reconcile.js';

/**
 * Bump when tool names, inputs or descriptions change in a way the assistant should notice. Together
 * with the system prompt it forms the conversation's `prompt_hash`; a mismatch on resume tells the
 * assistant its capabilities changed.
 */
export const CAPABILITIES_VERSION = '2026-10-15.1';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

/** Advisor-side tools: statements, notes, aliases, reconciliations and plan drafting. No ledger writes. */
export function registerAdvisorTools(server: McpServer, ctx: AppContext, session: McpSession): void {
  const { db } = ctx;

  // ---- statements ---------------------------------------------------------------------------
  server.registerTool(
    'statement_get',
    {
      title: 'Statement Get',
      description: 'Metadata of an ingested statement: institution, kind, account_id, period, opening/closing balance, status, line count.',
      inputSchema: z.object({ id: z.string().uuid() }),
    },
    async ({ id }) =>
      runTool(async () => {
        const s = await getStatement(db, id);
        if (!s) throw new Error(`statement ${id} not found`);
        const { lines, ...rest } = s;
        return { ...rest, line_count: lines?.length ?? 0 };
      }),
  );

  server.registerTool(
    'statement_lines',
    {
      title: 'Statement Lines',
      description:
        'Normalized statement lines (hash, date, posted_at, amount, raw, description_hint, fitid, kind, balance_after) with already_in_ledger / likely_duplicate flags, the household alias when known, and the top category candidates. Paginated.',
      inputSchema: z.object({ id: z.string().uuid(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50) }),
    },
    async ({ id, offset, limit }) =>
      runTool(async () => {
        const s = await getStatement(db, id);
        if (!s) throw new Error(`statement ${id} not found`);
        const lines = s.lines ?? [];
        return { total: lines.length, offset, limit, lines: lines.slice(offset, offset + limit) };
      }),
  );

  // ---- merchant aliases ---------------------------------------------------------------------
  server.registerTool(
    'merchant_alias_get',
    {
      title: 'Merchant Alias Get',
      description: 'Household short name for a raw statement text, if taught before (normalize_merchant is applied to the raw text).',
      inputSchema: z.object({ raw: z.string().min(1) }),
    },
    async ({ raw }) =>
      runTool(async () => {
        const row = await maybeOne(
          db,
          `SELECT ma.*, h.full_name AS account_name FROM merchant_aliases ma
           LEFT JOIN account_names_hierarchical h ON h.id = ma.account_id
           WHERE ma.raw_normalized = normalize_merchant($1)`,
          [raw],
        );
        return row ?? { found: false, raw_normalized: (await maybeOne<{ n: string }>(db, 'SELECT normalize_merchant($1) AS n', [raw]))?.n };
      }),
  );

  server.registerTool(
    'merchant_alias_set',
    {
      title: 'Merchant Alias Set',
      description:
        'Teach the household short name for a raw statement text, optionally with the usual category. Only after the user accepted the name. Writes the alias table only, never the ledger.',
      inputSchema: z.object({ raw: z.string().min(1), canonical_description: z.string().min(1).max(200), account_id: z.string().uuid().optional() }),
    },
    async ({ raw, canonical_description, account_id }) =>
      runTool(async () => {
        const row = await maybeOne(
          db,
          `INSERT INTO merchant_aliases (raw_normalized, canonical_description, account_id, source)
           VALUES (normalize_merchant($1), $2, $3, 'manual')
           ON CONFLICT (raw_normalized) DO UPDATE SET canonical_description = EXCLUDED.canonical_description,
             account_id = COALESCE(EXCLUDED.account_id, merchant_aliases.account_id), hits = merchant_aliases.hits + 1, updated_at = now()
           RETURNING *`,
          [raw, canonical_description, account_id ?? null],
        );
        return row;
      }),
  );

  // ---- reconciliations ----------------------------------------------------------------------
  server.registerTool(
    'reconciliation_history',
    {
      title: 'Reconciliation History',
      description: 'Past reconciliations of an account, newest first, with item counts per kind, plus reconciled_through and suspense balance.',
      inputSchema: z.object({ account_id: z.string().uuid(), limit: z.number().int().min(1).max(50).default(12) }),
    },
    async ({ account_id, limit }) =>
      runTool(async () => {
        const status = await maybeOne(db, 'SELECT * FROM account_reconciliation_status WHERE account_id = $1', [account_id]);
        const history = await reconciliationHistory(db, account_id, limit);
        return { status, history };
      }),
  );

  server.registerTool(
    'reconciliation_get',
    { title: 'Reconciliation Get', description: 'One reconciliation with all its items.', inputSchema: z.object({ id: z.string().uuid() }) },
    async ({ id }) =>
      runTool(async () => {
        const r = await reconciliationDetail(db, id);
        if (!r) throw new Error(`reconciliation ${id} not found`);
        return r;
      }),
  );

  // ---- notes --------------------------------------------------------------------------------
  server.registerTool(
    'note_list',
    {
      title: 'Note List',
      description: "The advisor's own memory: durable facts about accounts, categories or the household. Call before answering about an account.",
      inputSchema: z.object({ scope: z.enum(['global', 'account', 'category']).optional(), ref_id: z.string().uuid().optional() }),
    },
    async ({ scope, ref_id }) => runTool(() => listNotes(db, scope, ref_id ?? null)),
  );

  server.registerTool(
    'note_add',
    {
      title: 'Note Add',
      description: 'Record a durable fact the user stated (e.g. "the Itaú statement arrives on the 5th", "statement_source=nubank:1234567").',
      inputSchema: z.object({ scope: z.enum(['global', 'account', 'category']), ref_id: z.string().uuid().optional(), note: z.string().min(1).max(2000) }),
    },
    async ({ scope, ref_id, note }) => runTool(() => addNote(db, { scope, ref_id: ref_id ?? null, note, created_by: session.actor ?? 'advisor' })),
  );

  // ---- plans --------------------------------------------------------------------------------
  server.registerTool(
    'plan_create',
    {
      title: 'Plan Create',
      description: 'Create a draft plan bound to this conversation (optionally to a statement). Returns the plan id. Group one statement into one plan.',
      inputSchema: z.object({ title: z.string().min(1).max(200), statement_id: z.string().uuid().optional() }),
    },
    async ({ title, statement_id }) =>
      runTool(async () => {
        const plan = await createPlan(db, { conversation_id: session.conversationId, statement_id: statement_id ?? null, title, created_by: 'advisor' });
        if (statement_id) await db.query(`UPDATE advisor_statements SET status = 'planned' WHERE id = $1 AND status IN ('received','parsed')`, [statement_id]);
        ctx.bus.emitConversation(session.conversationId, { type: 'plan', planId: plan.id, status: plan.status, version: plan.version });
        return { id: plan.id, status: plan.status };
      }),
  );

  server.registerTool(
    'plan_set_items',
    {
      title: 'Plan Set Items',
      description:
        'Replace all items of a draft or pending plan. Each item: kind (create|update|delete|adjust|budget_upsert|budget_delete|mark_checked|skip|account_create|account_update), date, description, entries [{account_id, amount, currency, exchange_rate, amount_base}] balancing to zero, payload (kind-specific), source_ref {statement_id, line_hash, fitid}, confidence 0..1, rationale. account_create payload: {ref, name, type, subtype?, parent_id?, hidden?}; later items may use account_id "new:<ref>". account_update payload: {account_id, name?, subtype?, parent_id?, icon?, color?, hidden?}. Validation errors are returned with the item index; fix and call again.',
      inputSchema: z.object({ plan_id: z.string().uuid(), items: z.array(planItemInputSchema).max(2000) }),
    },
    async ({ plan_id, items }) =>
      runTool(async () => {
        const plan = await getPlan(db, plan_id);
        if (!plan) throw new Error(`plan ${plan_id} not found`);
        if (plan.conversation_id !== session.conversationId) throw new Error('plan belongs to another conversation');
        if (!['draft', 'pending_approval'].includes(plan.status)) throw new Error(`plan is ${plan.status}; create a new plan instead`);
        const accounts = await loadAccounts(db);
        const issues = validatePlanItems(items, accounts);
        if (issues.length > 0) return { ok: false, issues };
        const saved = await replacePlanItems(
          db,
          plan_id,
          items.map((it) => ({
            kind: it.kind,
            transaction_id: it.transaction_id ?? null,
            date: it.date ?? null,
            description: it.description ?? null,
            entries: it.entries,
            payload: { ...it.payload, ...(it.reopens_reconciliation ? { reopens_reconciliation: true } : {}) },
            source_ref: it.source_ref ?? null,
            confidence: it.confidence ?? null,
            rationale: it.rationale ?? null,
          })),
        );
        if (plan.status === 'pending_approval') await updatePlan(db, plan_id, { bumpVersion: true });
        const fresh = await getPlan(db, plan_id);
        ctx.bus.emitConversation(session.conversationId, { type: 'plan', planId: plan_id, status: fresh!.status, version: fresh!.version });
        return { ok: true, count: saved.length, version: fresh!.version };
      }),
  );

  server.registerTool(
    'plan_finalize',
    {
      title: 'Plan Finalize',
      description:
        'Move a draft plan to pending_approval with a short summary (counts, totals, balance check). Returns the computed balance check for the bound statement so you can report the difference. The user is notified.',
      inputSchema: z.object({ plan_id: z.string().uuid(), summary: z.string().min(1).max(4000) }),
    },
    async ({ plan_id, summary }) =>
      runTool(async () => {
        const plan = await getPlan(db, plan_id);
        if (!plan) throw new Error(`plan ${plan_id} not found`);
        if (plan.conversation_id !== session.conversationId) throw new Error('plan belongs to another conversation');
        if (!['draft', 'pending_approval'].includes(plan.status)) throw new Error(`plan is ${plan.status}`);
        const items = await listPlanItems(db, plan_id);
        if (items.length === 0) throw new Error('plan has no items');
        let balance = null;
        if (plan.statement_id) {
          let st = await getStatement(db, plan.statement_id);
          if (st) {
            st = await ensureStatementAccount(db, st, items);
            balance = await computePlanBalance(db, plan, items, st);
          }
        }
        const updated = await updatePlan(db, plan_id, { status: 'pending_approval', summary, result: balance ? { balance } : null });
        const withCounts = (await getPlan(db, plan_id))!;
        ctx.bus.emitConversation(session.conversationId, { type: 'plan', planId: plan_id, status: updated.status, version: updated.version });
        ctx.bus.emitGlobal({ type: 'plan', planId: plan_id, conversationId: session.conversationId, status: updated.status });
        void ctx.notifier.planPending({
          planId: plan_id,
          conversationId: session.conversationId,
          title: withCounts.title,
          summary,
          status: updated.status,
          version: updated.version,
          counts: {
            create: withCounts.create_count,
            update: withCounts.update_count,
            skip: withCounts.skip_count,
            adjust: withCounts.adjust_count,
            total: withCounts.item_count,
          },
          balance: balance ? { ok: balance.ok, difference: balance.difference, account_name: balance.account_name ?? undefined } : null,
        });
        return { status: updated.status, version: updated.version, balance };
      }),
  );

  server.registerTool(
    'plan_get',
    {
      title: 'Plan Get',
      description: 'Current plan state and items, including user edits (status edited/removed) and apply results.',
      inputSchema: z.object({ plan_id: z.string().uuid() }),
    },
    async ({ plan_id }) =>
      runTool(async () => {
        const plan = await getPlan(db, plan_id);
        if (!plan) throw new Error(`plan ${plan_id} not found`);
        const items = await listPlanItems(db, plan_id);
        return { plan, items };
      }),
  );

  server.registerTool(
    'plan_list',
    {
      title: 'Plan List',
      description: 'Plans of this conversation with their status and counts.',
      inputSchema: z.object({}),
    },
    async () => runTool(() => many(db, 'SELECT * FROM advisor_plans_with_counts WHERE conversation_id = $1 ORDER BY created_at DESC', [session.conversationId])),
  );

  // ---- conversation -------------------------------------------------------------------------
  server.registerTool(
    'conversation_summary_set',
    {
      title: 'Conversation Summary Set',
      description: 'Store a rolling summary of this conversation (what was decided, open questions). Keep it short.',
      inputSchema: z.object({ summary: z.string().min(1).max(4000), title: z.string().min(1).max(120).optional() }),
    },
    async ({ summary, title }) =>
      runTool(async () => {
        const conv = await getConversation(db, session.conversationId);
        if (!conv) throw new Error('conversation not found');
        const updated = await updateConversation(db, conv.id, { summary, ...(title ? { title } : {}) });
        ctx.bus.emitConversation(conv.id, { type: 'conversation', field: 'summary', value: summary });
        if (title) ctx.bus.emitConversation(conv.id, { type: 'conversation', field: 'title', value: title });
        return { ok: true, title: updated.title };
      }),
  );

  server.registerTool(
    'account_reconciliation_status',
    {
      title: 'Account Reconciliation Status',
      description: 'For every visible asset/liability account: reconciled_through, last status, open difference and suspense balance.',
      inputSchema: z.object({ account_id: z.string().uuid().optional(), through_date: dateSchema.optional() }),
    },
    async ({ account_id }) =>
      runTool(() =>
        many(
          db,
          `SELECT s.*, h.full_name AS account_name, a.last_checked FROM account_reconciliation_status s
           JOIN account_names_hierarchical h ON h.id = s.account_id JOIN accounts a ON a.id = s.account_id
           WHERE a.hidden = false AND ($1::uuid IS NULL OR s.account_id = $1) ORDER BY h.full_name`,
          [account_id ?? null],
        ),
      ),
  );
}
