import { z } from 'zod';
import type { PlanItemKind } from '../db/types.js';

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

/** A real account id, or `new:<ref>` pointing at an `account_create` item earlier in the same plan. */
export const NEW_ACCOUNT_REF = /^new:[a-z0-9][a-z0-9_-]{0,63}$/;
export const accountRefSchema = z.string().refine((v) => NEW_ACCOUNT_REF.test(v) || z.string().uuid().safeParse(v).success, 'account_id must be a uuid or new:<ref>');

export const ACCOUNT_TYPES = ['asset', 'liability', 'expense', 'income', 'equity'] as const;
export const ACCOUNT_SUBTYPES = ['checking', 'emergency', 'investments', 'liabilities', 'category', 'property', 'loan'] as const;
/** Which subtypes make sense for each account type (null is always allowed). */
export const SUBTYPES_BY_TYPE: Record<string, readonly string[]> = {
  asset: ['checking', 'emergency', 'investments', 'property'],
  liability: ['liabilities', 'loan'],
  expense: ['category'],
  income: ['category'],
  equity: [],
};

export const planEntrySchema = z.object({
  account_id: accountRefSchema,
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
  kind: z.enum(['create', 'update', 'delete', 'adjust', 'budget_upsert', 'budget_delete', 'mark_checked', 'skip', 'account_create', 'account_update']),
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
  subtype?: string | null;
}

/** Payload of an `account_create` item. `ref` lets later items in the plan use `new:<ref>` as account_id. */
export interface AccountCreatePayload {
  ref: string;
  name: string;
  type: (typeof ACCOUNT_TYPES)[number];
  subtype?: string | null;
  parent_id?: string | null;
  icon?: string | null;
  color?: string | null;
  hidden?: boolean;
}

/** Payload of an `account_update` item: the account and the fields to change. */
export interface AccountUpdatePayload {
  account_id: string;
  name?: string;
  subtype?: string | null;
  parent_id?: string | null;
  icon?: string | null;
  color?: string | null;
  hidden?: boolean;
}

const ACCOUNT_NAME = /^[a-z0-9][a-z0-9_.-]*$/;

function fullNameOf(parentId: string | null | undefined, name: string, accounts: Map<string, AccountInfo>, pending: Map<string, AccountInfo>): string {
  if (!parentId) return name;
  const parent = accounts.get(parentId) ?? pending.get(parentId);
  return parent ? `${parent.full_name}:${name}` : name;
}

function checkAccountFields(index: number, kind: string, p: Partial<AccountCreatePayload>, issues: ValidationIssue[], typeForSubtype: string | undefined): void {
  if (p.name !== undefined) {
    if (typeof p.name !== 'string' || !p.name.trim()) issues.push({ index, message: `${kind} needs a name` });
    else if (!ACCOUNT_NAME.test(p.name)) issues.push({ index, message: `account name "${p.name}" must be a lowercase slug (letters, digits, - _ .), no ":"` });
  }
  if (p.subtype !== undefined && p.subtype !== null) {
    if (!(ACCOUNT_SUBTYPES as readonly string[]).includes(p.subtype)) issues.push({ index, message: `unknown subtype "${p.subtype}" (one of ${ACCOUNT_SUBTYPES.join(', ')})` });
    else if (typeForSubtype && !(SUBTYPES_BY_TYPE[typeForSubtype] ?? []).includes(p.subtype)) issues.push({ index, message: `subtype "${p.subtype}" does not fit a ${typeForSubtype} account` });
  }
  if (p.hidden !== undefined && typeof p.hidden !== 'boolean') issues.push({ index, message: `${kind} hidden must be a boolean` });
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
  /** `new:<ref>` → the account an earlier account_create item will create */
  const pending = new Map<string, AccountInfo>();
  const lookup = (id: string): AccountInfo | undefined => accounts.get(id) ?? pending.get(id);
  items.forEach((it, index) => {
    if (it.kind === 'account_create') {
      const p = it.payload as Partial<AccountCreatePayload>;
      if (typeof p.ref !== 'string' || !NEW_ACCOUNT_REF.test(`new:${p.ref}`)) issues.push({ index, message: 'account_create payload needs a ref (lowercase slug) so later items can use new:<ref>' });
      else if (pending.has(`new:${p.ref}`)) issues.push({ index, message: `duplicate account ref "${p.ref}"` });
      if (!p.name) issues.push({ index, message: 'account_create payload needs a name' });
      if (!p.type || !(ACCOUNT_TYPES as readonly string[]).includes(p.type)) issues.push({ index, message: `account_create payload needs a type (${ACCOUNT_TYPES.join('|')})` });
      checkAccountFields(index, 'account_create', p, issues, p.type);
      let parentOk = true;
      if (p.parent_id) {
        const parent = lookup(p.parent_id);
        if (!parent) {
          issues.push({ index, message: `unknown parent_id ${p.parent_id}` });
          parentOk = false;
        } else if (parent.type !== p.type) issues.push({ index, message: `parent ${parent.full_name} is a ${parent.type} account, child must be ${parent.type} too` });
      }
      if (p.name && p.type && parentOk && typeof p.ref === 'string') {
        const full = fullNameOf(p.parent_id, p.name, accounts, pending);
        const clash = [...accounts.values()].find((a) => a.full_name === full);
        if (clash) issues.push({ index, message: `account ${full} already exists (${clash.id}); use its id instead of creating it` });
        pending.set(`new:${p.ref}`, { id: `new:${p.ref}`, full_name: full, type: p.type, hidden: Boolean(p.hidden), subtype: p.subtype ?? null });
      }
      return;
    }
    if (it.kind === 'account_update') {
      const p = it.payload as Partial<AccountUpdatePayload>;
      const acc = typeof p.account_id === 'string' ? accounts.get(p.account_id) : undefined;
      if (!acc) issues.push({ index, message: 'account_update payload needs a known account_id' });
      const fields = ['name', 'subtype', 'parent_id', 'icon', 'color', 'hidden'].filter((k) => (p as Record<string, unknown>)[k] !== undefined);
      if (fields.length === 0) issues.push({ index, message: 'account_update changes nothing (name, subtype, parent_id, icon, color or hidden)' });
      checkAccountFields(index, 'account_update', p as Partial<AccountCreatePayload>, issues, acc?.type);
      if (p.parent_id) {
        const parent = accounts.get(p.parent_id);
        if (!parent) issues.push({ index, message: `unknown parent_id ${p.parent_id}` });
        else if (acc && parent.type !== acc.type) issues.push({ index, message: `parent ${parent.full_name} is a ${parent.type} account` });
        else if (acc && (parent.id === acc.id || parent.full_name.startsWith(`${acc.full_name}:`))) issues.push({ index, message: 'an account cannot be moved under itself' });
      }
      return;
    }
    const needsEntries: PlanItemKind[] = ['create', 'update', 'adjust'];
    if (needsEntries.includes(it.kind)) {
      if (!it.date) issues.push({ index, message: `${it.kind} item needs a date` });
      if (!it.description || !it.description.trim()) issues.push({ index, message: `${it.kind} item needs a description` });
      if (it.entries.length < 2) issues.push({ index, message: `${it.kind} item needs at least two entries` });
      const sum = it.entries.reduce((s, e) => s + e.amount_base, 0);
      if (Math.abs(sum) >= EPS) issues.push({ index, message: `entries do not balance: SUM(amount_base) = ${round2(sum)}` });
      for (const e of it.entries) {
        const a = lookup(e.account_id);
        if (!a) issues.push({ index, message: e.account_id.startsWith('new:') ? `${e.account_id} is not created by an earlier account_create item` : `unknown account_id ${e.account_id}` });
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
      const acc = typeof p.account_id === 'string' ? lookup(p.account_id) : undefined;
      if (p.account_id && !acc) issues.push({ index, message: `unknown budget account_id ${String(p.account_id)}` });
      if (acc && acc.type !== 'expense') issues.push({ index, message: `budget account ${acc.full_name} is not an expense account` });
    }
    if (it.kind === 'budget_delete') {
      if (!(it.payload as Record<string, unknown>).id) issues.push({ index, message: 'budget_delete payload needs id' });
    }
    if (it.kind === 'mark_checked') {
      const accId = (it.payload as Record<string, unknown>).account_id;
      if (typeof accId !== 'string' || !lookup(accId)) issues.push({ index, message: 'mark_checked payload needs a known account_id' });
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
