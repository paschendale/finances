import type { Queryable } from '../db/client.js';
import { many } from '../db/client.js';

/**
 * `update_transaction` deletes and recreates a transaction's entries, which cascades away the
 * reconciliation items that cleared them. These helpers snapshot the clearings before an update,
 * attach them to the new entries afterwards (same account, same amount when possible) and bring
 * the affected reconciliations' totals and difference back in line with the ledger.
 */

export interface ClearingSnapshot {
  reconciliation_id: string;
  kind: string;
  statement_line_hash: string | null;
  amount: number | null;
  note: string | null;
  account_id: string;
  amount_base: number;
}

export async function snapshotClearings(q: Queryable, transactionId: string): Promise<ClearingSnapshot[]> {
  return many<ClearingSnapshot>(
    q,
    `SELECT ri.reconciliation_id, ri.kind, ri.statement_line_hash, ri.amount, ri.note, e.account_id, e.amount_base
     FROM reconciliation_items ri JOIN entries e ON e.id = ri.entry_id
     WHERE e.transaction_id = $1`,
    [transactionId],
  );
}

/** Re-attaches the snapshot to the transaction's current entries. Returns the reconciliation ids touched. */
export async function restoreClearings(q: Queryable, transactionId: string, snapshot: ClearingSnapshot[]): Promise<string[]> {
  if (snapshot.length === 0) return [];
  const entries = await many<{ id: string; account_id: string; amount_base: number }>(q, 'SELECT id, account_id, amount_base FROM entries WHERE transaction_id = $1', [transactionId]);
  const used = new Set<string>();
  const touched = new Set<string>();
  for (const s of snapshot) {
    const candidates = entries.filter((e) => e.account_id === s.account_id && !used.has(e.id));
    const entry = candidates.find((e) => Math.abs(e.amount_base - s.amount_base) < 0.005) ?? candidates[0];
    if (!entry) continue; // the leg on that account is gone: the reconciliation loses the clearing and shows the gap
    used.add(entry.id);
    await q.query(
      `INSERT INTO reconciliation_items (reconciliation_id, kind, entry_id, statement_line_hash, amount, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (reconciliation_id, entry_id) WHERE entry_id IS NOT NULL DO NOTHING`,
      [s.reconciliation_id, s.kind, entry.id, s.statement_line_hash, s.kind === 'cleared' ? entry.amount_base : s.amount, s.note],
    );
    touched.add(s.reconciliation_id);
  }
  return [...touched];
}

export interface ReconciliationState {
  id: string;
  account_id: string;
  period_end: string;
  status: string;
  difference: number | null;
  adjustment_transaction_id: string | null;
}

/** Recomputes cleared_total, ledger_closing and difference from the ledger as it is now. */
export async function recomputeReconciliations(q: Queryable, ids: string[]): Promise<ReconciliationState[]> {
  if (ids.length === 0) return [];
  await q.query(
    `UPDATE reconciliations r
     SET cleared_total = COALESCE((SELECT SUM(i.amount) FROM reconciliation_items i WHERE i.reconciliation_id = r.id AND i.kind = 'cleared'), 0),
         ledger_closing = ledger_balance_as_of(r.account_id, r.period_end)
     WHERE r.id = ANY($1::uuid[])`,
    [ids],
  );
  await q.query(`UPDATE reconciliations r SET difference = r.statement_closing - (r.ledger_opening + r.cleared_total) WHERE r.id = ANY($1::uuid[])`, [ids]);
  return many<ReconciliationState>(q, 'SELECT id, account_id, period_end, status, difference, adjustment_transaction_id FROM reconciliations WHERE id = ANY($1::uuid[]) ORDER BY period_end', [ids]);
}

/**
 * How a period reopened by a plan should be closed again after apply, from its recomputed state:
 * `balanced` when the difference is zero; `adjusted` again when it was adjusted before and its
 * adjustment transaction is still there (close_reconciliation checks the leg equals the difference);
 * null when it has to stay open for a person to look at.
 */
export function recloseDecision(state: ReconciliationState, previousStatus: string | null): 'balanced' | 'adjusted' | null {
  if (state.status !== 'open') return null;
  if (isBalanced(state)) return 'balanced';
  if (previousStatus === 'adjusted' && state.adjustment_transaction_id) return 'adjusted';
  return null;
}

export const BALANCED_EPS = 0.005;

export function isBalanced(r: Pick<ReconciliationState, 'difference'>): boolean {
  return r.difference != null && Math.abs(Number(r.difference)) < BALANCED_EPS;
}
