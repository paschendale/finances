import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { Actor } from '../auth.js';
import { getPlan, getPlanItem, listPlanItems, listPlans, updatePlan, updatePlanItem } from '../../db/repo/plans.js';
import { getStatement, updateStatement } from '../../db/repo/statements.js';
import { getConversation } from '../../db/repo/conversations.js';
import { approveAndApply, ApplyError, reconcileAppliedPlan, rejectPlan } from '../../plan/apply.js';
import { computePlanBalance, ensureStatementAccount, loadAccounts } from '../../plan/reconcile.js';
import { planEntrySchema, validatePlanItems, type PlanItemInputShape } from '../../plan/schema.js';

type Env = { Variables: { actor: Actor } };

const reconcileSchema = z.object({
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  opening_balance: z.number().optional(),
  closing_balance: z.number().optional(),
  account_id: z.string().uuid().optional(),
});

const itemPatchSchema = z.object({
  kind: z.enum(['create', 'update', 'delete', 'adjust', 'budget_upsert', 'budget_delete', 'mark_checked', 'skip']).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  description: z.string().max(500).optional(),
  entries: z.array(planEntrySchema).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['proposed', 'edited', 'removed']).optional(),
});

const approveSchema = z.object({ version: z.number().int(), keep_reopen_flags: z.boolean().optional() });
const replanSchema = z.object({ message: z.string().min(1).max(10_000) });

export function planRoutes(ctx: AppContext): Hono<Env> {
  const app = new Hono<Env>();

  app.get('/plans', async (c) => {
    const status = c.req.query('status');
    const plans = await listPlans(ctx.db, { status: status ? (status.split(',') as never) : undefined, limit: 200 });
    return c.json(plans);
  });

  app.get('/plans/:id', async (c) => {
    const plan = await getPlan(ctx.db, c.req.param('id'));
    if (!plan) return c.json({ error: 'not found' }, 404);
    const items = await listPlanItems(ctx.db, plan.id);
    let statement = plan.statement_id ? await getStatement(ctx.db, plan.statement_id) : null;
    if (statement) statement = await ensureStatementAccount(ctx.db, statement, items);
    const balance = statement ? await computePlanBalance(ctx.db, plan, items, statement) : null;
    const lines = new Map((statement?.lines ?? []).map((l) => [l.hash, l]));
    const accounts = await loadAccounts(ctx.db);
    return c.json({
      plan,
      items: items.map((it) => ({
        ...it,
        source_line: it.source_ref?.line_hash ? (lines.get(it.source_ref.line_hash) ?? null) : null,
        entries: it.entries.map((e) => ({ ...e, account_name: accounts.get(e.account_id)?.full_name ?? null, account_type: accounts.get(e.account_id)?.type ?? null })),
      })),
      statement: statement ? { ...statement, lines: undefined, line_count: statement.lines?.length ?? 0 } : null,
      balance,
    });
  });

  app.patch('/plans/:id/items/:itemId', async (c) => {
    const body = itemPatchSchema.parse(await c.req.json());
    const plan = await getPlan(ctx.db, c.req.param('id'));
    if (!plan) return c.json({ error: 'not found' }, 404);
    if (plan.status !== 'pending_approval' && plan.status !== 'draft') return c.json({ error: `plan is ${plan.status}` }, 409);
    const item = await getPlanItem(ctx.db, plan.id, c.req.param('itemId'));
    if (!item) return c.json({ error: 'item not found' }, 404);
    const merged = { ...item, ...body, payload: body.payload ?? item.payload, entries: body.entries ?? item.entries };
    const accounts = await loadAccounts(ctx.db);
    const nextStatus = body.status ?? (item.status === 'removed' ? 'removed' : 'edited');
    if (nextStatus !== 'removed') {
      const issues = validatePlanItems([merged as unknown as PlanItemInputShape], accounts);
      if (issues.length > 0) return c.json({ error: 'invalid item', issues }, 400);
    }
    const updated = await updatePlanItem(ctx.db, plan.id, item.id, { ...body, status: nextStatus });
    const bumped = await updatePlan(ctx.db, plan.id, { bumpVersion: true });
    ctx.bus.emitConversation(plan.conversation_id, { type: 'plan', planId: plan.id, status: bumped.status, version: bumped.version });
    return c.json({ item: updated, version: bumped.version });
  });

  app.post('/plans/:id/approve', async (c) => {
    const body = approveSchema.parse(await c.req.json());
    const actor = c.get('actor');
    try {
      const result = await approveAndApply(ctx, c.req.param('id'), { actor: actor.id, version: body.version, keepReopenFlags: body.keep_reopen_flags });
      return c.json(result, result.status === 'applied' ? 200 : 207);
    } catch (err) {
      if (err instanceof ApplyError) return c.json({ error: err.message }, err.status as 400);
      throw err;
    }
  });

  app.post('/plans/:id/reject', async (c) => {
    const actor = c.get('actor');
    try {
      const plan = await rejectPlan(ctx, c.req.param('id'), actor.id);
      return c.json(plan);
    } catch (err) {
      if (err instanceof ApplyError) return c.json({ error: err.message }, err.status as 400);
      throw err;
    }
  });

  /**
   * Opens the reconciliation of an applied statement plan that did not get one because the file had
   * no period or balances. The optional body fills those in on the statement first.
   */
  app.post('/plans/:id/reconcile', async (c) => {
    const actor = c.get('actor');
    const body = reconcileSchema.parse(await c.req.json().catch(() => ({})));
    try {
      const plan = await getPlan(ctx.db, c.req.param('id'));
      if (!plan) return c.json({ error: 'not found' }, 404);
      if (plan.statement_id && Object.values(body).some((v) => v !== undefined)) await updateStatement(ctx.db, plan.statement_id, body);
      const r = await reconcileAppliedPlan(ctx, plan.id, actor.id);
      return c.json({ reconciliation: r.reconciliation, cleared: r.cleared_count, outstanding: r.outstanding_count, missing: r.missing_count });
    } catch (err) {
      if (err instanceof ApplyError) return c.json({ error: err.message }, err.status as 400);
      throw err;
    }
  });

  /** "Ask the advisor to change this plan": a turn in the plan's conversation with the plan id in context. */
  app.post('/plans/:id/replan', async (c) => {
    const body = replanSchema.parse(await c.req.json());
    const plan = await getPlan(ctx.db, c.req.param('id'));
    if (!plan) return c.json({ error: 'not found' }, 404);
    const conv = await getConversation(ctx.db, plan.conversation_id);
    if (!conv) return c.json({ error: 'conversation not found' }, 404);
    const actor = c.get('actor');
    void ctx.sessions.sendUserMessage(conv.id, body.message, {
      actor: actor.id,
      kind: 'interactive',
      context: `The user is reviewing plan ${plan.id} (version ${plan.version}, status ${plan.status}). Revise it with plan_get + plan_set_items (+ plan_finalize if it was pending) instead of creating a new plan, unless they ask otherwise.`,
    });
    return c.json({ accepted: true, conversation_id: conv.id }, 202);
  });

  return app;
}
