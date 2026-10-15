import type { AppContext } from '../context.js';
import { many, maybeOne } from '../db/client.js';
import type { PlanItem, PlanWithCounts, Statement, StatementLine } from '../db/types.js';
import { getPlan, listPlanItems, updatePlan, updatePlanItem } from '../db/repo/plans.js';
import { getStatement, updateStatement } from '../db/repo/statements.js';
import { ensureStatementAccount, loadAccounts, reconcileAfterApply, type ReconcileOutcome } from './reconcile.js';
import { validatePlanItems, type AccountCreatePayload, type AccountUpdatePayload, type PlanItemInputShape } from './schema.js';
import { PostgrestError } from '../postgrest/client.js';
import { recloseDecision, recomputeReconciliations, restoreClearings, snapshotClearings, type ReconciliationState } from './clearings.js';
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
  /** Reconciliations this plan reopened (cleared entries edited/deleted), with their state after apply */
  reopened: ReconciliationState[];
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
  if (!plan) throw new ApplyError('Plano não encontrado.', 404);
  if (plan.status !== 'pending_approval') throw new ApplyError(plan.status === 'applied' ? 'Este plano já foi gravado.' : plan.status === 'rejected' ? 'Este plano já foi descartado.' : 'Este plano não está mais esperando aprovação.', 409);
  if (plan.version !== opts.version) throw new ApplyError('O plano mudou depois que você o abriu. Revise de novo antes de aprovar.', 409);

  const allItems = await listPlanItems(ctx.db, planId);
  const items = allItems.filter((i) => i.status !== 'removed' && i.status !== 'applied');
  if (items.length === 0) throw new ApplyError('Este plano não tem nada para gravar.', 400);

  const accounts = await loadAccounts(ctx.db);
  const issues = validatePlanItems(items as unknown as PlanItemInputShape[], accounts);
  if (issues.length > 0) throw new ApplyError(`Alguns itens do plano estão inválidos: ${issues.map((i) => `item ${items[i.index]?.seq}: ${i.message}`).join('; ')}`, 400);

  await updatePlan(ctx.db, planId, { status: 'applying', approved_by: opts.actor, approved_at: 'now' });
  ctx.bus.emitConversation(plan.conversation_id, { type: 'plan', planId, status: 'applying', version: plan.version });

  let statement = plan.statement_id ? await getStatement(ctx.db, plan.statement_id) : null;
  if (statement) statement = await ensureStatementAccount(ctx.db, statement, items);
  const result: ApplyResult = { plan_id: planId, status: 'applied', applied: 0, failed: 0, skipped: 0, items: [], reconciliation: null, reopened: [] };
  /** `new:<ref>` → id of the account created by an earlier item of this run */
  const created = new Map<string, string>();
  /** reconciliations touched by update/delete items of this run → their status before the run */
  const reopened = new Map<string, string>();

  for (const rawItem of items) {
    const item = resolveNewAccounts(rawItem, created);
    try {
      if (item.kind === 'account_create') {
        const id = await createAccount(ctx, item.payload as unknown as AccountCreatePayload);
        created.set(`new:${(item.payload as unknown as AccountCreatePayload).ref}`, id);
        await updatePlanItem(ctx.db, planId, item.id, { status: 'applied', payload: { ...item.payload, account_id: id }, error: null });
        result.applied++;
        result.items.push({ id: item.id, seq: item.seq, kind: item.kind, status: 'applied', transaction_id: null, error: null });
        continue;
      }
      const txId = await applyItem(ctx, plan, item, statement, { ...opts, reopened });
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

  // Periods reopened by this plan: refresh their numbers and close the ones that still balance.
  if (reopened.size > 0) {
    try {
      result.reopened = await recloseReopened(ctx, planId, reopened);
    } catch (err) {
      log.error({ planId, err }, 'reclosing reopened reconciliations failed');
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

  if (created.size > 0 || items.some((i) => i.kind === 'account_update')) ctx.bus.emitGlobal({ type: 'accounts', planId });

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
    reopened: r.reopened,
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

/** Replace `new:<ref>` placeholders (entries and payload account ids) with the ids created earlier in this run. */
function resolveNewAccounts(item: PlanItem, created: Map<string, string>): PlanItem {
  if (created.size === 0) return item;
  const sub = (v: unknown): unknown => (typeof v === 'string' && created.has(v) ? created.get(v) : v);
  const payload = { ...(item.payload as Record<string, unknown>) };
  for (const k of ['account_id', 'parent_id']) if (k in payload) payload[k] = sub(payload[k]);
  return { ...item, payload, entries: item.entries.map((e) => ({ ...e, account_id: String(sub(e.account_id)) })) };
}

const ACCOUNT_COLUMNS = 'id,name,type,subtype,parent_id,hidden';

/** Creates the account through PostgREST; an identical account that already exists is reused. */
async function createAccount(ctx: AppContext, p: AccountCreatePayload): Promise<string> {
  const body: Record<string, unknown> = { name: p.name, type: p.type, subtype: p.subtype ?? null, parent_id: p.parent_id ?? null, hidden: Boolean(p.hidden) };
  if (p.icon) body.icon = p.icon;
  if (p.color) body.color = p.color;
  try {
    const row = await ctx.pg.post<{ id: string }>('accounts', body);
    return row.id;
  } catch (err) {
    if (err instanceof PostgrestError && err.status === 409) {
      const params = new URLSearchParams({ select: ACCOUNT_COLUMNS, name: `eq.${p.name}`, parent_id: p.parent_id ? `eq.${p.parent_id}` : 'is.null' });
      const rows = await ctx.pg.get<Array<{ id: string; type: string }>>('accounts', params);
      const same = rows.find((r) => r.type === p.type);
      if (same) return same.id;
    }
    throw err;
  }
}

async function updateAccount(ctx: AppContext, p: AccountUpdatePayload): Promise<void> {
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'subtype', 'parent_id', 'icon', 'color', 'hidden'] as const) if (p[k] !== undefined) patch[k] = p[k];
  await ctx.pg.patch('accounts', new URLSearchParams({ id: `eq.${p.account_id}` }), patch);
}

/**
 * An update/delete on an entry cleared by a closed reconciliation needs the item's
 * `reopens_reconciliation` flag; the reconciliation is reopened (and remembered in `reopened`, so it
 * can be closed again after apply when it still balances). Open reconciliations are remembered too.
 */
async function guardCleared(ctx: AppContext, item: PlanItem, actor: string, keepReopenFlags: boolean | undefined, reopened: Map<string, string>): Promise<void> {
  if (!item.transaction_id) return;
  const clearings = await clearingsForTransaction(ctx, item.transaction_id);
  if (clearings.length === 0) return;
  const closed = clearings.filter((c) => c.status === 'balanced' || c.status === 'adjusted');
  for (const c of clearings) if (!reopened.has(c.reconciliation_id)) reopened.set(c.reconciliation_id, c.status);
  if (closed.length === 0) return;
  const flagged = Boolean((item.payload as Record<string, unknown>).reopens_reconciliation);
  if (!flagged || keepReopenFlags === false) {
    throw new Error(`este lançamento já foi conferido com o extrato até ${closed[0]!.period_end}; para alterá-lo é preciso reabrir essa conferência`);
  }
  for (const c of new Map(closed.map((c) => [c.reconciliation_id, c])).values()) {
    await ctx.pg.rpc('reopen_reconciliation', { p_id: c.reconciliation_id, p_notes: `reopened by plan ${item.plan_id} item #${item.seq} (${item.kind}) approved by ${actor}` });
  }
}

/** Recomputes the reopened periods from the ledger and closes again the ones that still work out. */
async function recloseReopened(ctx: AppContext, planId: string, reopened: Map<string, string>): Promise<ReconciliationState[]> {
  const states = await recomputeReconciliations(ctx.db, [...reopened.keys()]);
  const out: ReconciliationState[] = [];
  for (const r of states) {
    const decision = recloseDecision(r, reopened.get(r.id) ?? null);
    if (!decision) {
      out.push(r);
      continue;
    }
    try {
      const closed = await ctx.pg.rpc<ReconciliationState>('close_reconciliation', {
        p_id: r.id,
        p_status: decision,
        p_adjustment_transaction_id: decision === 'adjusted' ? r.adjustment_transaction_id : null,
        p_notes: `closed again after plan ${planId}`,
      });
      out.push({ ...r, status: closed.status ?? decision });
    } catch (err) {
      log.warn({ planId, reconciliationId: r.id, err: (err as Error).message }, 'could not close the reopened period again; it stays open');
      out.push(r);
    }
  }
  return out;
}

async function applyItem(ctx: AppContext, plan: PlanWithCounts, item: PlanItem, statement: Statement | null, opts: { actor: string; keepReopenFlags?: boolean; reopened: Map<string, string> }): Promise<string | null> {
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
      await guardCleared(ctx, item, opts.actor, opts.keepReopenFlags, opts.reopened);
      // update_transaction recreates the entries, which drops their clearings: carry them over.
      const snapshot = await snapshotClearings(ctx.db, item.transaction_id!);
      const res = await ctx.pg.rpc<{ id: string }>('update_transaction', {
        p_id: item.transaction_id,
        p_date: item.date,
        p_description: item.description,
        p_entries: item.entries,
        p_metadata: provenance(plan, item, statement, opts.actor),
      });
      for (const id of await restoreClearings(ctx.db, res.id, snapshot)) if (!opts.reopened.has(id)) opts.reopened.set(id, 'open');
      return res.id;
    }
    case 'delete': {
      await guardCleared(ctx, item, opts.actor, opts.keepReopenFlags, opts.reopened);
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
    case 'account_update': {
      await updateAccount(ctx, payload as unknown as AccountUpdatePayload);
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
  if (!plan) throw new ApplyError('Plano não encontrado.', 404);
  if (!['draft', 'pending_approval'].includes(plan.status)) throw new ApplyError(plan.status === 'applied' ? 'Este plano já foi gravado e não pode ser descartado.' : 'Este plano já foi tratado.', 409);
  await updatePlan(ctx.db, planId, { status: 'rejected', approved_by: actor, result: { ...(plan.result ?? {}), rejected_by: actor, rejected_at: new Date().toISOString() } });
  const fresh = (await getPlan(ctx.db, planId))!;
  ctx.bus.emitConversation(plan.conversation_id, { type: 'plan', planId, status: fresh.status, version: fresh.version });
  ctx.bus.emitGlobal({ type: 'plan', planId, conversationId: plan.conversation_id, status: fresh.status });
  return fresh;
}
