import type { AppContext } from '../context.js';
import { many, maybeOne } from '../db/client.js';
import type { PlanItem, PlanWithCounts, Statement, StatementLine } from '../db/types.js';
import { getPlan, listPlanItems, updatePlan, updatePlanItem } from '../db/repo/plans.js';
import { getStatement, updateStatement } from '../db/repo/statements.js';
import { loadAccounts, reconcileAfterApply, type ReconcileOutcome } from './reconcile.js';
import { validatePlanItems, type PlanItemInputShape } from './schema.js';
import { scoped } from '../log.js';

const log = scoped('plan.apply');

export class ApplyError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'ApplyError';
  }
}

export interface ApplyResult {
  plan_id: string;
  status: 'applied' | 'failed';
  applied: number;
  failed: number;
  skipped: number;
  items: Array<{ id: string; seq: number; kind: string; status: string; transaction_id: string | null; error: string | null }>;
  reconciliation: ReconcileOutcome | null;
}

interface Clearing {
  entry_id: string;
  reconciliation_id: string;
  period_end: string;
  status: string;
}

async function clearingsForTransaction(ctx: AppContext, transactionId: string): Promise<Clearing[]> {
  return many<Clearing>(
    ctx.db,
    `SELECT ec.entry_id, ec.reconciliation_id, ec.period_end, ec.status FROM entry_clearings ec
     JOIN entries e ON e.id = ec.entry_id WHERE e.transaction_id = $1`,
    [transactionId],
  );
}

function lineFor(statement: Statement | null, item: PlanItem): StatementLine | null {
  if (!statement?.lines || !item.source_ref?.line_hash) return null;
  return statement.lines.find((l) => l.hash === item.source_ref!.line_hash) ?? null;
}

function provenance(plan: PlanWithCounts, item: PlanItem, statement: Statement | null, actor: string | null): Record<string, unknown> {
  const line = lineFor(statement, item);
  const meta: Record<string, unknown> = {
    source: 'advisor',
    plan_id: plan.id,
    plan_item_id: item.id,
    approved_by: actor,
    applied_at: new Date().toISOString(),
  };
  if (statement) {
    meta.statement_id = statement.id;
    if (statement.institution) meta.institution = statement.institution;
  }
  if (line) {
    if (line.fitid) meta.fitid = line.fitid;
    meta.statement_line_hash = line.hash;
    meta.statement_line = { raw: line.raw, posted_at: line.posted_at ?? null, fitid: line.fitid ?? null, hash: line.hash };
  } else if (item.source_ref?.fitid) {
    meta.fitid = item.source_ref.fitid;
  }
  if (item.kind === 'adjust') meta.kind = 'adjust';
  return meta;
}

/** Approve (version-checked) and apply a plan, item by item, through PostgREST RPCs. */
export async function approveAndApply(ctx: AppContext, planId: string, opts: { actor: string; version: number; keepReopenFlags?: boolean }): Promise<ApplyResult> {
  const plan = await getPlan(ctx.db, planId);
  if (!plan) throw new ApplyError('plan not found', 404);
  if (plan.status !== 'pending_approval') throw new ApplyError(`plan is ${plan.status}, not pending approval`, 409);
  if (plan.version !== opts.version) throw new ApplyError(`plan changed (version ${plan.version}, you approved ${opts.version}); review it again`, 409);

  const allItems = await listPlanItems(ctx.db, planId);
  const items = allItems.filter((i) => i.status !== 'removed' && i.status !== 'applied');
  if (items.length === 0) throw new ApplyError('plan has no items to apply', 400);

  const accounts = await loadAccounts(ctx.db);
  const issues = validatePlanItems(items as unknown as PlanItemInputShape[], accounts);
  if (issues.length > 0) throw new ApplyError(`plan has invalid items: ${issues.map((i) => `#${items[i.index]?.seq}: ${i.message}`).join('; ')}`, 400);

  await updatePlan(ctx.db, planId, { status: 'applying', approved_by: opts.actor, approved_at: 'now' });
  ctx.bus.emitConversation(plan.conversation_id, { type: 'plan', planId, status: 'applying', version: plan.version });

  const statement = plan.statement_id ? await getStatement(ctx.db, plan.statement_id) : null;
  const result: ApplyResult = { plan_id: planId, status: 'applied', applied: 0, failed: 0, skipped: 0, items: [], reconciliation: null };

  for (const item of items) {
    try {
      const txId = await applyItem(ctx, plan, item, statement, opts);
      await updatePlanItem(ctx.db, planId, item.id, { status: 'applied', applied_transaction_id: txId, error: null });
      if (item.kind === 'skip') result.skipped++;
      else result.applied++;
      result.items.push({ id: item.id, seq: item.seq, kind: item.kind, status: 'applied', transaction_id: txId, error: null });
    } catch (err) {
      const msg = (err as Error).message;
      await updatePlanItem(ctx.db, planId, item.id, { status: 'failed', error: msg });
      result.failed++;
      result.items.push({ id: item.id, seq: item.seq, kind: item.kind, status: 'failed', transaction_id: null, error: msg });
      log.warn({ planId, seq: item.seq, kind: item.kind, err: msg }, 'plan item failed; stopping');
      break; // never continue past a failure: later items may depend on this one
    }
  }

  const appliedItems = await listPlanItems(ctx.db, planId);
  if (result.failed === 0 && statement) {
    try {
      result.reconciliation = await reconcileAfterApply(ctx.db, ctx.pg, plan, appliedItems, statement, opts.actor);
    } catch (err) {
      log.error({ planId, err }, 'reconciliation after apply failed');
      result.reconciliation = null;
    }
    await updateStatement(ctx.db, statement.id, { status: 'applied' });
    ctx.bus.emitGlobal({ type: 'statement', statementId: statement.id, conversationId: statement.conversation_id, status: 'applied' });
  }

  result.status = result.failed > 0 ? 'failed' : 'applied';
  const stored = await updatePlan(ctx.db, planId, {
    status: result.status,
    applied_at: result.status === 'applied' ? 'now' : null,
    result: { ...(plan.result ?? {}), apply: summarise(result) },
  });
  ctx.bus.emitConversation(plan.conversation_id, { type: 'plan', planId, status: stored.status, version: stored.version });
  ctx.bus.emitGlobal({ type: 'plan', planId, conversationId: plan.conversation_id, status: stored.status });
  void ctx.notifier.planApplied({
    planId,
    conversationId: plan.conversation_id,
    title: plan.title,
    summary: plan.summary,
    status: stored.status,
    version: stored.version,
    counts: { create: plan.create_count, update: plan.update_count, skip: plan.skip_count, adjust: plan.adjust_count, total: plan.item_count },
    balance: result.reconciliation
      ? { ok: result.reconciliation.reconciliation.status !== 'open', difference: result.reconciliation.reconciliation.difference ?? 0 }
      : null,
    result: summarise(result),
  });
  return result;
}

function summarise(r: ApplyResult): Record<string, unknown> {
  return {
    status: r.status,
    applied: r.applied,
    failed: r.failed,
    skipped: r.skipped,
    failed_items: r.items.filter((i) => i.status === 'failed'),
    reconciliation: r.reconciliation
      ? {
          id: r.reconciliation.reconciliation.id,
          status: r.reconciliation.reconciliation.status,
          difference: r.reconciliation.reconciliation.difference,
          period_end: r.reconciliation.reconciliation.period_end,
          cleared: r.reconciliation.cleared_count,
          outstanding: r.reconciliation.outstanding_count,
          missing: r.reconciliation.missing_count,
          notes: r.reconciliation.reconciliation.notes,
        }
      : null,
  };
}

async function guardCleared(ctx: AppContext, item: PlanItem, actor: string, keepReopenFlags: boolean | undefined): Promise<void> {
  if (!item.transaction_id) return;
  const clearings = await clearingsForTransaction(ctx, item.transaction_id);
  const closed = clearings.filter((c) => c.status === 'balanced' || c.status === 'adjusted');
  if (closed.length === 0) return;
  const flagged = Boolean((item.payload as Record<string, unknown>).reopens_reconciliation);
  if (!flagged || keepReopenFlags === false) {
    throw new Error(`transaction is cleared by a closed reconciliation (period ending ${closed[0]!.period_end}); keep the reopens_reconciliation flag to proceed`);
  }
  for (const c of new Map(closed.map((c) => [c.reconciliation_id, c])).values()) {
    await ctx.pg.rpc('reopen_reconciliation', { p_id: c.reconciliation_id, p_notes: `reopened by plan ${item.plan_id} item #${item.seq} (${item.kind}) approved by ${actor}` });
  }
}

async function applyItem(ctx: AppContext, plan: PlanWithCounts, item: PlanItem, statement: Statement | null, opts: { actor: string; keepReopenFlags?: boolean }): Promise<string | null> {
  const payload = item.payload as Record<string, unknown>;
  switch (item.kind) {
    case 'skip':
      return item.transaction_id ?? null;
    case 'create':
    case 'adjust': {
      const res = await ctx.pg.rpc<{ id: string }>('create_transaction', {
        p_date: item.date,
        p_description: item.description,
        p_entries: item.entries,
        p_metadata: provenance(plan, item, statement, opts.actor),
      });
      return res.id;
    }
    case 'update': {
      await guardCleared(ctx, item, opts.actor, opts.keepReopenFlags);
      const res = await ctx.pg.rpc<{ id: string }>('update_transaction', {
        p_id: item.transaction_id,
        p_date: item.date,
        p_description: item.description,
        p_entries: item.entries,
        p_metadata: provenance(plan, item, statement, opts.actor),
      });
      return res.id;
    }
    case 'delete': {
      await guardCleared(ctx, item, opts.actor, opts.keepReopenFlags);
      const okDel = await ctx.pg.rpc<boolean>('delete_transaction', { p_id: item.transaction_id });
      if (okDel === false) throw new Error('transaction not found');
      return item.transaction_id;
    }
    case 'budget_upsert': {
      await ctx.pg.rpc('upsert_budget_item', {
        p_plan_id: payload.plan_id,
        p_account_id: payload.account_id,
        p_period_amount: payload.period_amount,
        p_min_pct: payload.min_pct,
        p_max_pct: payload.max_pct,
        p_sort_order: payload.sort_order ?? 0,
        p_category_type: payload.category_type ?? 'yearly',
      });
      return null;
    }
    case 'budget_delete': {
      await ctx.pg.rpc('delete_budget_item', { p_id: payload.id });
      return null;
    }
    case 'mark_checked': {
      const accountId = String(payload.account_id);
      const exists = await maybeOne(ctx.db, 'SELECT id FROM accounts WHERE id = $1', [accountId]);
      if (!exists) throw new Error('account not found');
      await ctx.pg.patch('accounts', new URLSearchParams({ id: `eq.${accountId}` }), { last_checked: new Date().toISOString() });
      return null;
    }
    default:
      throw new Error(`unknown item kind ${String(item.kind)}`);
  }
}

export async function rejectPlan(ctx: AppContext, planId: string, actor: string): Promise<PlanWithCounts> {
  const plan = await getPlan(ctx.db, planId);
  if (!plan) throw new ApplyError('plan not found', 404);
  if (!['draft', 'pending_approval'].includes(plan.status)) throw new ApplyError(`plan is ${plan.status}`, 409);
  await updatePlan(ctx.db, planId, { status: 'rejected', approved_by: actor, result: { ...(plan.result ?? {}), rejected_by: actor, rejected_at: new Date().toISOString() } });
  const fresh = (await getPlan(ctx.db, planId))!;
  ctx.bus.emitConversation(plan.conversation_id, { type: 'plan', planId, status: fresh.status, version: fresh.version });
  ctx.bus.emitGlobal({ type: 'plan', planId, conversationId: plan.conversation_id, status: fresh.status });
  return fresh;
}
