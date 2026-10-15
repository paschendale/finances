import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../../context.js';
import type { McpSession } from '../tokens.js';
import { runTool } from '../result.js';
import { many, maybeOne } from '../../db/client.js';
import { getStatement, updateStatement } from '../../db/repo/statements.js';
import { toCsv } from '../../ingest/normalize.js';
import { ApplyError, reconcileAppliedPlan } from '../../plan/apply.js';
import { addNote, listNotes } from '../../db/repo/misc.js';
import { appendPlanItems, createPlan, getPlan, listPlanItems, planStatementIds, replacePlanItems, updatePlan } from '../../db/repo/plans.js';
import { prepareBatch } from '../../plan/batch.js';
import { ledgerBalanceAsOf } from '../../plan/reconcile.js';
import { planDeltasByAccount, round2 } from '../../plan/schema.js';
import { getConversation, updateConversation } from '../../db/repo/conversations.js';
import { planItemInputSchema, validatePlanItems } from '../../plan/schema.js';
import { computePlanBalance, ensureStatementAccount, loadAccounts, reconciliationDetail, reconciliationHistory } from '../../plan/reconcile.js';

/**
 * Bump when tool names, inputs or descriptions change in a way the assistant should notice. Together
 * with the system prompt it forms the conversation's `prompt_hash`; a mismatch on resume tells the
 * assistant its capabilities changed.
 */
export const CAPABILITIES_VERSION = '2026-10-15.7';

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

  server.registerTool(
    'statement_list',
    {
      title: 'Statement List',
      description:
        'Recent statements across all conversations (newest first): id, filename, institution, kind, period, status, line count, the conversation they sit in and whether they are still waiting for their planning turn. Use it when a person says they sent statements by email, before saying nothing arrived.',
      inputSchema: z.object({ institution: z.string().optional(), kind: z.enum(['account', 'card', 'investment', 'other']).optional(), limit: z.number().int().min(1).max(100).default(30) }),
    },
    async ({ institution, kind, limit }) =>
      runTool(async () =>
        many(
          db,
          `SELECT s.id, s.filename, s.institution, s.kind, s.format, s.status, s.period_start, s.period_end, s.opening_balance, s.closing_balance,
                  s.account_id, s.source, s.created_at, s.conversation_id, c.title AS conversation_title,
                  COALESCE(jsonb_array_length(s.lines), 0)::int AS line_count,
                  (s.status IN ('parsed','failed') AND NOT EXISTS (SELECT 1 FROM advisor_plans p WHERE p.status <> 'rejected' AND (p.statement_id = s.id OR s.id = ANY(COALESCE(p.statement_ids, '{}'::uuid[]))))) AS waiting
           FROM advisor_statements s LEFT JOIN advisor_conversations c ON c.id = s.conversation_id
           WHERE ($1::text IS NULL OR s.institution = $1) AND ($2::text IS NULL OR s.kind = $2)
           ORDER BY s.created_at DESC LIMIT $3`,
          [institution ?? null, kind ?? null, limit],
        ),
      ),
  );

  server.registerTool(
    'mailbox_check',
    {
      title: 'Mailbox Check',
      description:
        'Reads the watched mailbox now instead of waiting for the next scheduled check, and returns the mails handled with the statements they produced. Call it when a person says they sent or forwarded statements by email; then statement_list / statement_claim.',
      inputSchema: z.object({}),
    },
    async () =>
      runTool(async () => {
        if (!ctx.gmail) throw new Error('no mailbox is connected to this advisor');
        return ctx.gmail.tick({ interactive: { actor: session.actor ?? 'advisor' } });
      }),
  );

  server.registerTool(
    'statement_claim',
    {
      title: 'Statement Claim',
      description:
        'Brings statements that arrived elsewhere (mailed statements waiting in their own conversation) into this conversation so you can plan them here, now. Only statements still waiting for their planning turn can be claimed. Returns their metadata; plan them oldest first, one plan per period.',
      inputSchema: z.object({ ids: z.array(z.string().uuid()).min(1).max(24) }),
    },
    async ({ ids }) =>
      runTool(async () => {
        const out = [];
        for (const id of ids) {
          const st = await getStatement(db, id);
          if (!st) throw new Error(`statement ${id} not found`);
          if (st.conversation_id !== session.conversationId) {
            const planned = await maybeOne(db, `SELECT 1 FROM advisor_plans WHERE status <> 'rejected' AND (statement_id = $1 OR $1 = ANY(COALESCE(statement_ids, '{}'::uuid[])))`, [id]);
            if (planned) throw new Error(`statement ${id} already has a plan in conversation ${st.conversation_id}`);
            if (st.conversation_id && ctx.sessions.isBusy(st.conversation_id)) throw new Error(`statement ${id} is being planned right now in conversation ${st.conversation_id}`);
            const source = st.conversation_id;
            await updateStatement(db, id, { conversation_id: session.conversationId });
            if (source) {
              await db.query(
                `UPDATE advisor_conversations SET status = 'archived'
                 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM advisor_statements x WHERE x.conversation_id = $1 AND x.status <> 'ignored')
                   AND NOT EXISTS (SELECT 1 FROM advisor_messages m WHERE m.conversation_id = $1)`,
                [source],
              );
            }
            ctx.bus.emitGlobal({ type: 'statement', statementId: id, conversationId: session.conversationId, status: st.status });
          }
          if (st.storage_path) await ctx.sessions.attachStatement(session.conversationId, st, st.storage_path, st.lines ? toCsv(st.lines) : null);
          const lines = st.lines ?? [];
          out.push({
            id: st.id,
            filename: st.filename,
            institution: st.institution,
            kind: st.kind,
            format: st.format,
            status: st.status,
            account_id: st.account_id,
            period_start: st.period_start,
            period_end: st.period_end,
            opening_balance: st.opening_balance,
            closing_balance: st.closing_balance,
            line_count: lines.length,
            already_in_ledger: lines.filter((l) => l.already_in_ledger).length,
            likely_duplicate: lines.filter((l) => l.likely_duplicate && !l.already_in_ledger).length,
            error: st.error,
          });
        }
        out.sort((a, b) => (a.period_start ?? '9999').localeCompare(b.period_start ?? '9999'));
        return { statements: out, note: 'Files are now under statements/ in the workspace. Plan them oldest first, one plan per period (plan_create with the statement_id), checking continuity between periods.' };
      }),
  );

  server.registerTool(
    'statement_set_meta',
    {
      title: 'Statement Set Meta',
      description:
        'Records the period, balances and/or ledger account of a statement the system could not read (a PDF with no recognised lines), from what you read in the file. Do it before plan_finalize: without period, closing balance and account the app cannot open the reconciliation and the account never shows as checked. When the plan was already applied, the reconciliation is opened now.',
      inputSchema: z.object({
        id: z.string().uuid(),
        period_start: dateSchema.optional(),
        period_end: dateSchema.optional(),
        opening_balance: z.number().optional(),
        closing_balance: z.number().optional(),
        account_id: z.string().uuid().optional(),
      }),
    },
    async ({ id, ...patch }) =>
      runTool(async () => {
        const st = await getStatement(db, id);
        if (!st) throw new Error(`statement ${id} not found`);
        if (st.conversation_id !== session.conversationId) throw new Error('statement belongs to another conversation (statement_claim it first)');
        const updated = await updateStatement(db, id, patch);
        const { lines, ...rest } = updated;
        const applied = await maybeOne<{ id: string }>(db, `SELECT id FROM advisor_plans WHERE status = 'applied' AND (statement_id = $1 OR $1 = ANY(COALESCE(statement_ids, '{}'::uuid[]))) ORDER BY applied_at DESC LIMIT 1`, [id]);
        let reconciliation: unknown = null;
        if (applied) {
          try {
            const r = await reconcileAppliedPlan(ctx, applied.id, session.actor);
            reconciliation = { id: r.reconciliation.id, status: r.reconciliation.status, difference: r.reconciliation.difference, cleared: r.cleared_count, outstanding: r.outstanding_count, missing: r.missing_count };
          } catch (err) {
            reconciliation = { error: err instanceof ApplyError ? err.message : (err as Error).message };
          }
        }
        return { ...rest, line_count: lines?.length ?? 0, reconciliation };
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
      description: 'Create a draft plan bound to this conversation, optionally to one or several statements of one account (statement_ids). For statements prefer batch_prepare, which creates the plan and vouches lines for you. Returns the plan id.',
      inputSchema: z.object({ title: z.string().min(1).max(200), statement_id: z.string().uuid().optional(), statement_ids: z.array(z.string().uuid()).max(24).optional() }),
    },
    async ({ title, statement_id, statement_ids }) =>
      runTool(async () => {
        const ids = statement_ids?.length ? statement_ids : statement_id ? [statement_id] : [];
        const plan = await createPlan(db, { conversation_id: session.conversationId, statement_ids: ids, title, created_by: 'advisor' });
        if (ids.length) await db.query(`UPDATE advisor_statements SET status = 'planned' WHERE id = ANY($1::uuid[]) AND status IN ('received','parsed')`, [ids]);
        ctx.bus.emitConversation(session.conversationId, { type: 'plan', planId: plan.id, status: plan.status, version: plan.version });
        return { id: plan.id, status: plan.status };
      }),
  );

  server.registerTool(
    'batch_prepare',
    {
      title: 'Batch Prepare',
      description:
        'Starts the check of one or several statements of ONE account in a single plan. Vouches every line that already matches a ledger entry on the account (same amount, one candidate within 3 days; no item needed), drafts the cent corrections as automatic update items, creates the draft plan and returns the digest: per period, the unmatched lines (with alias and category candidates) and the ledger entries no line vouches for. Pass account_id when the statements do not know their account yet. Continue with plan_add_items and plan_finalize.',
      inputSchema: z.object({ statement_ids: z.array(z.string().uuid()).min(1).max(24), account_id: z.string().uuid().optional() }),
    },
    async ({ statement_ids, account_id }) =>
      runTool(async () => {
        const digest = await prepareBatch(ctx, { conversationId: session.conversationId, statementIds: statement_ids, accountId: account_id ?? null, createdBy: 'advisor' });
        ctx.bus.emitConversation(session.conversationId, { type: 'plan', planId: digest.plan_id, status: 'draft', version: 1 });
        return digest;
      }),
  );

  server.registerTool(
    'plan_add_items',
    {
      title: 'Plan Add Items',
      description:
        'Appends items to a draft or pending plan, keeping the ones already there (the automatic corrections from batch_prepare). Same item shape as plan_set_items. Validation errors come back with the item index; fix and call again. Call it in chunks when there are many items.',
      inputSchema: z.object({ plan_id: z.string().uuid(), items: z.array(planItemInputSchema).min(1).max(500) }),
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
        const saved = await appendPlanItems(
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
        return { ok: true, added: saved.length, total: fresh!.item_count, version: fresh!.version };
      }),
  );

  server.registerTool(
    'plan_projected_balance',
    {
      title: 'Plan Projected Balance',
      description:
        'The balance the account will show today once the plan is applied: ledger balance as of today plus the plan\'s effect on the account. Compare it with the figure the person reads in the bank app. Returns ledger_today, plan_delta, projected and the account.',
      inputSchema: z.object({ plan_id: z.string().uuid(), account_id: z.string().uuid().optional() }),
    },
    async ({ plan_id, account_id }) =>
      runTool(async () => {
        const plan = await getPlan(db, plan_id);
        if (!plan) throw new Error(`plan ${plan_id} not found`);
        if (plan.conversation_id !== session.conversationId) throw new Error('plan belongs to another conversation');
        let acc = account_id ?? null;
        if (!acc) {
          for (const sid of planStatementIds(plan)) {
            const st = await getStatement(db, sid);
            if (st?.account_id) { acc = st.account_id; break; }
          }
        }
        if (!acc) throw new Error('pass account_id: the plan\'s statements do not know their account');
        const items = (await listPlanItems(db, plan_id)).filter((i) => i.status !== 'removed');
        const today = new Date().toISOString().slice(0, 10);
        const ledgerToday = await ledgerBalanceAsOf(db, acc, today);
        let delta = planDeltasByAccount(items.filter((i) => i.kind !== 'update')).get(acc) ?? 0;
        for (const it of items) {
          if ((it.kind === 'update' || it.kind === 'delete') && it.transaction_id) {
            const old = await maybeOne<{ s: number }>(db, 'SELECT COALESCE(sum(amount_base), 0)::float8 AS s FROM entries WHERE transaction_id = $1 AND account_id = $2', [it.transaction_id, acc]);
            delta = round2(delta - Number(old?.s ?? 0));
            if (it.kind === 'update') delta = round2(delta + it.entries.filter((e) => e.account_id === acc).reduce((s, e) => s + e.amount_base, 0));
          }
        }
        const name = await maybeOne<{ full_name: string }>(db, 'SELECT full_name FROM account_names_hierarchical WHERE id = $1', [acc]);
        return { account_id: acc, account_name: name?.full_name ?? null, as_of: today, ledger_today: round2(ledgerToday), plan_delta: round2(delta), projected: round2(ledgerToday + delta) };
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
        // One balance check per period, oldest first; `balance` is the last period's (what the account shows at the end).
        const balances = [];
        const sts = [];
        for (const sid of planStatementIds(plan)) {
          const st = await getStatement(db, sid);
          if (st) sts.push(await ensureStatementAccount(db, st, items));
        }
        sts.sort((a, b) => (a.period_start ?? '9999').localeCompare(b.period_start ?? '9999'));
        for (const st of sts) {
          const b = await computePlanBalance(db, plan, items, st);
          if (b) balances.push(b);
        }
        const balance = balances[balances.length - 1] ?? null;
        const prev = (plan.result ?? {}) as Record<string, unknown>;
        const updated = await updatePlan(db, plan_id, { status: 'pending_approval', summary, result: { ...prev, balance, balances } });
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
        return { status: updated.status, version: updated.version, balance, balances: balances.map((b) => ({ period_start: b.period_start, period_end: b.period_end, ok: b.ok, difference: b.difference, statement_closing: b.statement_closing, projected: b.projected, outstanding_count: b.outstanding_count })) };
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
