import type { Db, Queryable } from '../db/client.js';
import { many, maybeOne, one } from '../db/client.js';
import type { Plan, PlanItem, Reconciliation, Statement } from '../db/types.js';
import { updateStatement } from '../db/repo/statements.js';
import type { PostgrestClient } from '../postgrest/client.js';
import { balanceCheck, planDeltasByAccount, round2, type AccountInfo, type BalanceCheck } from './schema.js';

export async function loadAccounts(q: Queryable): Promise<Map<string, AccountInfo>> {
  const rows = await many<AccountInfo>(
    q,
    `SELECT h.id, h.full_name, h.type, a.hidden, a.subtype FROM account_names_hierarchical h JOIN accounts a ON a.id = h.id`,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * The statement's ledger account is the asset/liability account shared by the plan's items: the
 * most frequent such account across create/update/adjust entries and skip items' transactions.
 */
export async function inferStatementAccount(q: Queryable, items: PlanItem[]): Promise<string | null> {
  const accounts = await loadAccounts(q);
  const votes = new Map<string, number>();
  const vote = (id: string) => votes.set(id, (votes.get(id) ?? 0) + 1);
  const skipTx: string[] = [];
  for (const it of items) {
    if (it.status === 'removed') continue;
    if (it.kind === 'skip' && it.transaction_id) skipTx.push(it.transaction_id);
    for (const e of it.entries) {
      const a = accounts.get(e.account_id);
      if (a && (a.type === 'asset' || a.type === 'liability')) vote(e.account_id);
    }
  }
  if (skipTx.length > 0) {
    const rows = await many<{ account_id: string }>(
      q,
      `SELECT e.account_id FROM entries e JOIN accounts a ON a.id = e.account_id
       WHERE e.transaction_id = ANY($1::uuid[]) AND a.type IN ('asset','liability')`,
      [skipTx],
    );
    for (const r of rows) vote(r.account_id);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [id, n] of votes) if (n > bestN) [best, bestN] = [id, n];
  return best;
}

/** Fills statement.account_id from the plan when ingestion could not resolve it. */
export async function ensureStatementAccount(q: Queryable, statement: Statement, items: PlanItem[]): Promise<Statement> {
  if (statement.account_id) return statement;
  const inferred = await inferStatementAccount(q, items);
  if (!inferred) return statement;
  return updateStatement(q, statement.id, { account_id: inferred });
}

export async function ledgerBalanceAsOf(q: Queryable, accountId: string, date: string): Promise<number> {
  const row = await one<{ bal: number }>(q, 'SELECT ledger_balance_as_of($1, $2::date) AS bal', [accountId, date]);
  return Number(row.bal);
}

export function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

interface PeriodEntry {
  entry_id: string;
  transaction_id: string;
  amount_base: number;
  date: string;
  description: string;
}

export async function entriesInPeriod(q: Queryable, accountId: string, start: string, end: string): Promise<PeriodEntry[]> {
  return many<PeriodEntry>(
    q,
    `SELECT e.id AS entry_id, e.transaction_id, e.amount_base, t.date, t.description
     FROM entries e JOIN transactions t ON t.id = e.transaction_id
     WHERE e.account_id = $1 AND t.date BETWEEN $2 AND $3
     ORDER BY t.date, t.created_at`,
    [accountId, start, end],
  );
}

export interface PlanBalanceReport extends BalanceCheck {
  account_name: string | null;
  period_start: string;
  period_end: string;
  outstanding_count: number;
  outstanding_total: number;
  outstanding: Array<{ transaction_id: string; date: string; description: string; amount_base: number }>;
  ledger_period_total: number;
}

/**
 * Pre-apply balance check for a plan bound to a statement:
 *   difference = statement_closing − (ledger_opening + Σ cleared + Σ plan deltas on the account)
 * Cleared = existing entries on the account vouched by a statement line (ledger_transaction_id).
 * Outstanding = entries in the period that neither a line nor the plan touches; listed, not subtracted.
 */
export async function computePlanBalance(db: Db, plan: Plan, items: PlanItem[], statement: Statement): Promise<PlanBalanceReport | null> {
  if (!statement.account_id || statement.closing_balance === null || !statement.period_start || !statement.period_end) return null;
  const accountId = statement.account_id;
  const acc = await maybeOne<{ full_name: string }>(db, 'SELECT full_name FROM account_names_hierarchical WHERE id = $1', [accountId]);
  const opening = await ledgerBalanceAsOf(db, accountId, dayBefore(statement.period_start));
  const period = await entriesInPeriod(db, accountId, statement.period_start, statement.period_end);

  const vouched = new Set<string>();
  for (const line of statement.lines ?? []) {
    if (line.ledger_transaction_id) vouched.add(line.ledger_transaction_id);
  }
  for (const it of items) {
    if (it.status === 'removed') continue;
    if (it.kind === 'skip' && it.transaction_id) vouched.add(it.transaction_id);
    if (it.kind === 'update' && it.transaction_id) vouched.add(it.transaction_id);
  }
  const touched = new Set<string>();
  for (const it of items) if (it.transaction_id && it.status !== 'removed') touched.add(it.transaction_id);

  let cleared = 0;
  let planDelta = 0;
  const outstanding: PlanBalanceReport['outstanding'] = [];
  for (const e of period) {
    if (vouched.has(e.transaction_id) && !isUpdatedOrDeleted(items, e.transaction_id)) cleared = round2(cleared + e.amount_base);
    else if (!touched.has(e.transaction_id)) outstanding.push({ transaction_id: e.transaction_id, date: e.date, description: e.description, amount_base: e.amount_base });
  }
  // Plan deltas: creates/adjusts add their account leg; updates replace the old legs; deletes remove them.
  const deltas = planDeltasByAccount(items.filter((i) => i.kind !== 'update'));
  planDelta = round2(planDelta + (deltas.get(accountId) ?? 0));
  for (const it of items) {
    if (it.status === 'removed') continue;
    if (it.kind === 'update' && it.transaction_id) {
      const newLeg = it.entries.filter((e) => e.account_id === accountId).reduce((s, e) => s + e.amount_base, 0);
      planDelta = round2(planDelta + newLeg); // old legs were excluded from cleared above
    }
  }
  const check = balanceCheck({ account_id: accountId, ledger_opening: opening, cleared_total: cleared, plan_delta: planDelta, statement_closing: statement.closing_balance });
  return {
    ...check,
    account_name: acc?.full_name ?? null,
    period_start: statement.period_start,
    period_end: statement.period_end,
    outstanding_count: outstanding.length,
    outstanding_total: round2(outstanding.reduce((s, o) => s + o.amount_base, 0)),
    outstanding,
    ledger_period_total: round2(period.reduce((s, e) => s + e.amount_base, 0)),
  };
}

function isUpdatedOrDeleted(items: PlanItem[], transactionId: string): boolean {
  return items.some((i) => i.status !== 'removed' && i.transaction_id === transactionId && (i.kind === 'update' || i.kind === 'delete'));
}

export interface ReconcileOutcome {
  reconciliation: Reconciliation;
  cleared_count: number;
  outstanding_count: number;
  missing_count: number;
}

/**
 * After an apply: open a reconciliation for the statement period, clear every entry a statement
 * line vouches for, list outstanding and missing items, and close it balanced when the difference
 * is zero or adjusted when the plan carried an applied adjustment.
 */
export async function reconcileAfterApply(
  db: Db,
  pg: PostgrestClient,
  plan: Plan,
  items: PlanItem[],
  statement: Statement,
  actor: string | null,
): Promise<ReconcileOutcome | null> {
  if (!statement.account_id || statement.closing_balance === null || !statement.period_start || !statement.period_end) return null;
  const accountId = statement.account_id;

  const vouchedTx = new Set<string>();
  const lineByTx = new Map<string, string>();
  for (const line of statement.lines ?? []) {
    if (line.ledger_transaction_id) {
      vouchedTx.add(line.ledger_transaction_id);
      lineByTx.set(line.ledger_transaction_id, line.hash);
    }
  }
  for (const it of items) {
    if (it.status === 'applied' && it.applied_transaction_id && (it.kind === 'create' || it.kind === 'update')) {
      vouchedTx.add(it.applied_transaction_id);
      if (it.source_ref?.line_hash) lineByTx.set(it.applied_transaction_id, it.source_ref.line_hash);
    }
    if (it.kind === 'skip' && it.transaction_id) {
      vouchedTx.add(it.transaction_id);
      if (it.source_ref?.line_hash && !lineByTx.has(it.transaction_id)) lineByTx.set(it.transaction_id, it.source_ref.line_hash);
    }
  }
  const period = await entriesInPeriod(db, accountId, statement.period_start, statement.period_end);
  const recItems: Array<Record<string, unknown>> = [];
  const clearedEntries = new Set<string>();
  for (const e of period) {
    if (vouchedTx.has(e.transaction_id)) {
      clearedEntries.add(e.entry_id);
      recItems.push({ kind: 'cleared', entry_id: e.entry_id, statement_line_hash: lineByTx.get(e.transaction_id) ?? null, amount: e.amount_base });
    } else {
      recItems.push({ kind: 'outstanding', entry_id: e.entry_id, amount: e.amount_base, note: e.description });
    }
  }
  const coveredHashes = new Set(items.filter((i) => i.status !== 'removed' && i.source_ref?.line_hash).map((i) => i.source_ref!.line_hash!));
  let missing = 0;
  for (const line of statement.lines ?? []) {
    if (!line.ledger_transaction_id && !coveredHashes.has(line.hash)) {
      missing++;
      recItems.push({ kind: 'missing', statement_line_hash: line.hash, amount: line.amount, note: line.raw });
    }
  }

  const opened = await pg.rpc<Reconciliation>('open_reconciliation', {
    p_account_id: accountId,
    p_period_start: statement.period_start,
    p_period_end: statement.period_end,
    p_statement_opening: statement.opening_balance,
    p_statement_closing: statement.closing_balance,
    p_currency: statement.currency,
    p_statement_ref: statement.id,
    p_created_by: actor,
  });
  let rec = await pg.rpc<Reconciliation>('set_reconciliation_items', { p_id: opened.id, p_items: recItems });

  const adjust = items.find((i) => i.kind === 'adjust' && i.status === 'applied' && i.applied_transaction_id);
  if (adjust && rec.difference !== null && Math.abs(rec.difference) >= 0.005) {
    try {
      rec = await pg.rpc<Reconciliation>('close_reconciliation', {
        p_id: rec.id,
        p_status: 'adjusted',
        p_adjustment_transaction_id: adjust.applied_transaction_id,
        p_notes: adjust.rationale ?? 'adjustment approved in plan',
      });
    } catch {
      /* leave open; the difference stays visible */
    }
  } else if (rec.difference !== null && Math.abs(rec.difference) < 0.005) {
    rec = await pg.rpc<Reconciliation>('close_reconciliation', { p_id: rec.id, p_status: 'balanced', p_adjustment_transaction_id: null, p_notes: null });
  }
  return {
    reconciliation: rec,
    cleared_count: clearedEntries.size,
    outstanding_count: recItems.filter((i) => i.kind === 'outstanding').length,
    missing_count: missing,
  };
}

export async function reconciliationHistory(q: Queryable, accountId: string, limit = 12): Promise<Array<Reconciliation & { items: unknown[] }>> {
  const recs = await many<Reconciliation>(q, 'SELECT * FROM reconciliations WHERE account_id = $1 ORDER BY period_end DESC, created_at DESC LIMIT $2', [accountId, limit]);
  const out: Array<Reconciliation & { items: unknown[] }> = [];
  for (const r of recs) {
    const items = await many(q, `SELECT kind, count(*)::int AS count, round(sum(amount), 2) AS total FROM reconciliation_items WHERE reconciliation_id = $1 GROUP BY kind`, [r.id]);
    out.push({ ...r, items });
  }
  return out;
}

export async function reconciliationDetail(q: Queryable, id: string): Promise<(Reconciliation & { items: unknown[] }) | null> {
  const r = await maybeOne<Reconciliation>(q, 'SELECT * FROM reconciliations WHERE id = $1', [id]);
  if (!r) return null;
  const items = await many(
    q,
    `SELECT ri.kind, ri.entry_id, ri.statement_line_hash, ri.amount, ri.note, t.id AS transaction_id, t.date, t.description
     FROM reconciliation_items ri
     LEFT JOIN entries e ON e.id = ri.entry_id
     LEFT JOIN transactions t ON t.id = e.transaction_id
     WHERE ri.reconciliation_id = $1 ORDER BY ri.kind, t.date`,
    [id],
  );
  return { ...r, items };
}
