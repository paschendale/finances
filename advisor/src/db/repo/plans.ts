import type { Queryable } from '../client.js';
import { many, maybeOne, one } from '../client.js';
import type { Plan, PlanItem, PlanItemKind, PlanItemStatus, PlanStatus, PlanWithCounts, PlanEntry } from '../types.js';

export async function createPlan(
  q: Queryable,
  input: { conversation_id: string; statement_id?: string | null; statement_ids?: string[] | null; title: string; created_by?: string | null },
): Promise<Plan> {
  const ids = input.statement_ids?.length ? input.statement_ids : input.statement_id ? [input.statement_id] : null;
  return one<Plan>(
    q,
    `INSERT INTO advisor_plans (conversation_id, statement_id, statement_ids, title, created_by)
     VALUES ($1, $2, $3::uuid[], $4, $5) RETURNING *`,
    [input.conversation_id, ids?.[0] ?? null, ids, input.title, input.created_by ?? null],
  );
}

/** The statement periods a plan covers, in the order they were bound. */
export function planStatementIds(plan: Pick<Plan, 'statement_id' | 'statement_ids'>): string[] {
  if (plan.statement_ids?.length) return plan.statement_ids;
  return plan.statement_id ? [plan.statement_id] : [];
}

export async function getPlan(q: Queryable, id: string): Promise<PlanWithCounts | null> {
  return maybeOne<PlanWithCounts>(q, 'SELECT * FROM advisor_plans_with_counts WHERE id = $1', [id]);
}

export async function listPlans(q: Queryable, opts: { status?: PlanStatus[]; conversation_id?: string; limit?: number } = {}): Promise<PlanWithCounts[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.status && opts.status.length > 0) {
    vals.push(opts.status);
    where.push(`status = ANY($${vals.length}::text[])`);
  }
  if (opts.conversation_id) {
    vals.push(opts.conversation_id);
    where.push(`conversation_id = $${vals.length}`);
  }
  vals.push(opts.limit ?? 100);
  return many<PlanWithCounts>(
    q,
    `SELECT * FROM advisor_plans_with_counts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT $${vals.length}`,
    vals,
  );
}

export async function updatePlan(
  q: Queryable,
  id: string,
  patch: Partial<Pick<Plan, 'title' | 'summary' | 'status' | 'approved_by' | 'result'>> & { bumpVersion?: boolean; approved_at?: 'now' | null; applied_at?: 'now' | null },
): Promise<Plan> {
  const sets: string[] = ['updated_at = now()'];
  const vals: unknown[] = [];
  const push = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.title !== undefined) push('title', patch.title);
  if (patch.summary !== undefined) push('summary', patch.summary);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.approved_by !== undefined) push('approved_by', patch.approved_by);
  if (patch.result !== undefined) push('result', JSON.stringify(patch.result));
  if (patch.approved_at === 'now') sets.push('approved_at = now()');
  if (patch.applied_at === 'now') sets.push('applied_at = now()');
  if (patch.bumpVersion) sets.push('version = version + 1');
  vals.push(id);
  return one<Plan>(q, `UPDATE advisor_plans SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
}

export interface PlanItemInput {
  kind: PlanItemKind;
  transaction_id?: string | null;
  date?: string | null;
  description?: string | null;
  entries?: PlanEntry[];
  payload?: Record<string, unknown>;
  source_ref?: PlanItem['source_ref'];
  confidence?: number | null;
  rationale?: string | null;
  status?: PlanItemStatus;
}

export async function replacePlanItems(q: Queryable, planId: string, items: PlanItemInput[]): Promise<PlanItem[]> {
  await q.query('DELETE FROM advisor_plan_items WHERE plan_id = $1', [planId]);
  const out: PlanItem[] = [];
  let seq = 1;
  for (const it of items) {
    out.push(
      await one<PlanItem>(
        q,
        `INSERT INTO advisor_plan_items (plan_id, seq, kind, transaction_id, date, description, entries, payload, source_ref, confidence, rationale, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12) RETURNING *`,
        [
          planId,
          seq++,
          it.kind,
          it.transaction_id ?? null,
          it.date ?? null,
          it.description ?? null,
          JSON.stringify(it.entries ?? []),
          JSON.stringify(it.payload ?? {}),
          it.source_ref ? JSON.stringify(it.source_ref) : null,
          it.confidence ?? null,
          it.rationale ?? null,
          it.status ?? 'proposed',
        ],
      ),
    );
  }
  await q.query('UPDATE advisor_plans SET updated_at = now() WHERE id = $1', [planId]);
  return out;
}

/** Appends items after the plan's current last seq (the system's automatic items stay in place). */
export async function appendPlanItems(q: Queryable, planId: string, items: PlanItemInput[]): Promise<PlanItem[]> {
  const row = await one<{ n: number }>(q, 'SELECT COALESCE(max(seq), 0)::int AS n FROM advisor_plan_items WHERE plan_id = $1', [planId]);
  let seq = Number(row.n);
  const out: PlanItem[] = [];
  for (const it of items) {
    seq++;
    out.push(
      await one<PlanItem>(
        q,
        `INSERT INTO advisor_plan_items (plan_id, seq, kind, transaction_id, date, description, entries, payload, source_ref, confidence, rationale, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12) RETURNING *`,
        [
          planId,
          seq,
          it.kind,
          it.transaction_id ?? null,
          it.date ?? null,
          it.description ?? null,
          JSON.stringify(it.entries ?? []),
          JSON.stringify(it.payload ?? {}),
          it.source_ref ? JSON.stringify(it.source_ref) : null,
          it.confidence ?? null,
          it.rationale ?? null,
          it.status ?? 'proposed',
        ],
      ),
    );
  }
  return out;
}

export async function listPlanItems(q: Queryable, planId: string): Promise<PlanItem[]> {
  return many<PlanItem>(q, 'SELECT * FROM advisor_plan_items WHERE plan_id = $1 ORDER BY seq', [planId]);
}

export async function getPlanItem(q: Queryable, planId: string, itemId: string): Promise<PlanItem | null> {
  return maybeOne<PlanItem>(q, 'SELECT * FROM advisor_plan_items WHERE plan_id = $1 AND id = $2', [planId, itemId]);
}

export async function updatePlanItem(
  q: Queryable,
  planId: string,
  itemId: string,
  patch: Partial<Pick<PlanItem, 'kind' | 'date' | 'description' | 'entries' | 'payload' | 'confidence' | 'rationale' | 'status' | 'applied_transaction_id' | 'error'>>,
): Promise<PlanItem> {
  const sets: string[] = ['updated_at = now()'];
  const vals: unknown[] = [];
  const push = (col: string, v: unknown, cast = '') => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}${cast}`);
  };
  if (patch.kind !== undefined) push('kind', patch.kind);
  if (patch.date !== undefined) push('date', patch.date);
  if (patch.description !== undefined) push('description', patch.description);
  if (patch.entries !== undefined) push('entries', JSON.stringify(patch.entries), '::jsonb');
  if (patch.payload !== undefined) push('payload', JSON.stringify(patch.payload), '::jsonb');
  if (patch.confidence !== undefined) push('confidence', patch.confidence);
  if (patch.rationale !== undefined) push('rationale', patch.rationale);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.applied_transaction_id !== undefined) push('applied_transaction_id', patch.applied_transaction_id);
  if (patch.error !== undefined) push('error', patch.error);
  vals.push(planId, itemId);
  return one<PlanItem>(
    q,
    `UPDATE advisor_plan_items SET ${sets.join(', ')} WHERE plan_id = $${vals.length - 1} AND id = $${vals.length} RETURNING *`,
    vals,
  );
}
