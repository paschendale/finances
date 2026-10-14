import { describe, expect, it } from 'vitest';
import { balanceCheck, planDeltasByAccount, planItemInputSchema, validatePlanItems, type AccountInfo } from '../src/plan/schema.js';

const A = '11111111-1111-4111-8111-111111111111';
const CAT = '22222222-2222-4222-8222-222222222222';
const HIDDEN = '33333333-3333-4333-8333-333333333333';
const AJ = '44444444-4444-4444-8444-444444444444';

const accounts = new Map<string, AccountInfo>([
  [A, { id: A, full_name: 'nu-conta', type: 'asset', hidden: false }],
  [CAT, { id: CAT, full_name: 'alimentacao:basica', type: 'expense', hidden: false }],
  [HIDDEN, { id: HIDDEN, full_name: 'empresa:caixa', type: 'asset', hidden: true }],
  [AJ, { id: AJ, full_name: 'ajustes', type: 'expense', hidden: false }],
]);

const entry = (account_id: string, amount: number) => ({ account_id, amount, currency: 'BRL', exchange_rate: 1, amount_base: amount });

describe('validatePlanItems', () => {
  it('accepts a balanced create', () => {
    const item = planItemInputSchema.parse({ kind: 'create', date: '2026-10-01', description: 'Tampopo', entries: [entry(CAT, 45.9), entry(A, -45.9)], confidence: 0.9 });
    expect(validatePlanItems([item], accounts)).toEqual([]);
  });
  it('rejects unbalanced entries, hidden accounts and unknown ids', () => {
    const item = planItemInputSchema.parse({ kind: 'create', date: '2026-10-01', description: 'x', entries: [entry(CAT, 10), entry(HIDDEN, -8), entry('55555555-5555-4555-8555-555555555555', -1)] });
    const issues = validatePlanItems([item], accounts).map((i) => i.message);
    expect(issues.some((m) => m.includes('do not balance'))).toBe(true);
    expect(issues.some((m) => m.includes('hidden'))).toBe(true);
    expect(issues.some((m) => m.includes('unknown account_id'))).toBe(true);
  });
  it('requires transaction_id for update/delete and an ajustes leg for adjust', () => {
    const upd = planItemInputSchema.parse({ kind: 'update', date: '2026-10-01', description: 'x', entries: [entry(CAT, 1), entry(A, -1)] });
    expect(validatePlanItems([upd], accounts).map((i) => i.message)).toContain('update item needs transaction_id');
    const adj = planItemInputSchema.parse({ kind: 'adjust', date: '2026-10-01', description: 'Ajuste', entries: [entry(CAT, 10), entry(A, -10)] });
    expect(validatePlanItems([adj], accounts).map((i) => i.message)).toContain('adjust item must have a leg on "ajustes"');
    const okAdj = planItemInputSchema.parse({ kind: 'adjust', date: '2026-10-01', description: 'Ajuste', entries: [entry(AJ, 10), entry(A, -10)] });
    expect(validatePlanItems([okAdj], accounts)).toEqual([]);
  });
  it('validates budget and mark_checked payloads', () => {
    const b = planItemInputSchema.parse({ kind: 'budget_upsert', payload: { plan_id: 'p', account_id: A, period_amount: 1, min_pct: 60, max_pct: 140 } });
    expect(validatePlanItems([b], accounts).map((i) => i.message)).toContain('budget account nu-conta is not an expense account');
    const mc = planItemInputSchema.parse({ kind: 'mark_checked', payload: { account_id: A } });
    expect(validatePlanItems([mc], accounts)).toEqual([]);
  });
  it('tolerates floating point noise under half a cent', () => {
    const item = planItemInputSchema.parse({ kind: 'create', date: '2026-10-01', description: 'x', entries: [entry(CAT, 0.1 + 0.2), entry(A, -0.3)] });
    expect(validatePlanItems([item], accounts)).toEqual([]);
  });
});

describe('balance arithmetic', () => {
  it('sums plan deltas per account ignoring removed and skip items', () => {
    const d = planDeltasByAccount([
      { kind: 'create', entries: [entry(CAT, 10), entry(A, -10)] },
      { kind: 'create', status: 'removed', entries: [entry(CAT, 99), entry(A, -99)] },
      { kind: 'skip', entries: [entry(A, -5)] },
      { kind: 'adjust', entries: [entry(AJ, 2.5), entry(A, -2.5)] },
    ]);
    expect(d.get(A)).toBe(-12.5);
    expect(d.get(CAT)).toBe(10);
  });
  it('implements difference = closing − (opening + cleared + plan)', () => {
    const c = balanceCheck({ account_id: A, ledger_opening: 1546.74, cleared_total: -900.53, plan_delta: 11, statement_closing: 657.21 });
    expect(c.projected).toBe(657.21);
    expect(c.difference).toBe(0);
    expect(c.ok).toBe(true);
    const bad = balanceCheck({ account_id: A, ledger_opening: 1546.74, cleared_total: -900.53, plan_delta: 0, statement_closing: 657.21 });
    expect(bad.difference).toBe(11);
    expect(bad.ok).toBe(false);
  });
});
