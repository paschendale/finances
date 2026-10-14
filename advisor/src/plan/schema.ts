import { z } from 'zod';
import type { PlanItemKind } from '../db/types.js';

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export const planEntrySchema = z.object({
  account_id: z.string().uuid(),
  amount: z.number(),
  currency: z.string().min(3).max(3),
  exchange_rate: z.number().positive().default(1),
  amount_base: z.number(),
});

export const sourceRefSchema = z
  .object({
    statement_id: z.string().uuid().optional(),
    line_hash: z.string().optional(),
    fitid: z.string().optional(),
  })
  .optional()
  .nullable();

export const planItemInputSchema = z.object({
  kind: z.enum(['create', 'update', 'delete', 'adjust', 'budget_upsert', 'budget_delete', 'mark_checked', 'skip']),
  transaction_id: z.string().uuid().optional().nullable(),
  date: dateSchema.optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  entries: z.array(planEntrySchema).default([]),
  payload: z.record(z.string(), z.unknown()).default({}),
  source_ref: sourceRefSchema,
  confidence: z.number().min(0).max(1).optional().nullable(),
  rationale: z.string().max(2000).optional().nullable(),
  reopens_reconciliation: z.boolean().optional(),
});

export type PlanItemInputShape = z.infer<typeof planItemInputSchema>;

export interface AccountInfo {
  id: string;
  full_name: string;
  type: string;
  hidden: boolean;
}

export interface ValidationIssue {
  index: number;
  message: string;
}

const EPS = 0.005;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Validates plan items against the ledger model: balance to zero in amount_base, known and
 * visible accounts, dates, kind-specific requirements. Returns issues, empty when valid.
 */
export function validatePlanItems(items: PlanItemInputShape[], accounts: Map<string, AccountInfo>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  items.forEach((it, index) => {
    const needsEntries: PlanItemKind[] = ['create', 'update', 'adjust'];
    if (needsEntries.includes(it.kind)) {
      if (!it.date) issues.push({ index, message: `${it.kind} item needs a date` });
      if (!it.description || !it.description.trim()) issues.push({ index, message: `${it.kind} item needs a description` });
      if (it.entries.length < 2) issues.push({ index, message: `${it.kind} item needs at least two entries` });
      const sum = it.entries.reduce((s, e) => s + e.amount_base, 0);
      if (Math.abs(sum) >= EPS) issues.push({ index, message: `entries do not balance: SUM(amount_base) = ${round2(sum)}` });
      for (const e of it.entries) {
        const a = accounts.get(e.account_id);
        if (!a) issues.push({ index, message: `unknown account_id ${e.account_id}` });
        else if (a.hidden) issues.push({ index, message: `account ${a.full_name} is hidden and out of scope` });
        if (!Number.isFinite(e.amount) || !Number.isFinite(e.amount_base)) issues.push({ index, message: 'non-numeric amount' });
      }
    }
    if (it.kind === 'update' || it.kind === 'delete') {
      if (!it.transaction_id) issues.push({ index, message: `${it.kind} item needs transaction_id` });
    }
    if (it.kind === 'adjust') {
      const ajustes = [...accounts.values()].find((a) => a.full_name === 'ajustes');
      if (!ajustes) issues.push({ index, message: 'suspense account "ajustes" is missing' });
      else if (!it.entries.some((e) => e.account_id === ajustes.id)) issues.push({ index, message: 'adjust item must have a leg on "ajustes"' });
    }
    if (it.kind === 'budget_upsert') {
      const p = it.payload as Record<string, unknown>;
      for (const k of ['plan_id', 'account_id', 'period_amount', 'min_pct', 'max_pct']) {
        if (p[k] === undefined || p[k] === null) issues.push({ index, message: `budget_upsert payload needs ${k}` });
      }
      const acc = typeof p.account_id === 'string' ? accounts.get(p.account_id) : undefined;
      if (p.account_id && !acc) issues.push({ index, message: `unknown budget account_id ${String(p.account_id)}` });
      if (acc && acc.type !== 'expense') issues.push({ index, message: `budget account ${acc.full_name} is not an expense account` });
    }
    if (it.kind === 'budget_delete') {
      if (!(it.payload as Record<string, unknown>).id) issues.push({ index, message: 'budget_delete payload needs id' });
    }
    if (it.kind === 'mark_checked') {
      const accId = (it.payload as Record<string, unknown>).account_id;
      if (typeof accId !== 'string' || !accounts.get(accId)) issues.push({ index, message: 'mark_checked payload needs a known account_id' });
    }
  });
  return issues;
}

/** Net effect of a plan on an account's balance (amount_base), per account id. Skips removed items. */
export function planDeltasByAccount(items: Array<{ kind: PlanItemKind; status?: string; entries: Array<{ account_id: string; amount_base: number }> }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    if (it.status === 'removed') continue;
    if (!['create', 'adjust', 'update'].includes(it.kind)) continue;
    for (const e of it.entries) out.set(e.account_id, round2((out.get(e.account_id) ?? 0) + e.amount_base));
  }
  return out;
}

export interface BalanceCheck {
  account_id: string;
  ledger_opening: number;
  cleared_total: number;
  plan_delta: number;
  statement_closing: number;
  projected: number;
  difference: number;
  ok: boolean;
}

/** difference = statement_closing − (ledger_opening + Σ cleared + Σ plan deltas); ok when |difference| < 0.005 */
export function balanceCheck(input: { account_id: string; ledger_opening: number; cleared_total: number; plan_delta: number; statement_closing: number }): BalanceCheck {
  const projected = round2(input.ledger_opening + input.cleared_total + input.plan_delta);
  const difference = round2(input.statement_closing - projected);
  return { ...input, projected, difference, ok: Math.abs(difference) < EPS };
}
