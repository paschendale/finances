import { describe, expect, it } from 'vitest';
import { advisorReasons } from './advisor-reasons';
import type { Account, DashboardEntry } from './api';

const acc = (over: Partial<Account>): Account => ({
  account_id: over.account_id ?? 'a', account_name: over.account_name ?? 'nu-conta', account_type: 'asset', subtype: 'checking',
  balance: 100, own_balance: 100, future_balance: 0, last_entry_date: '2026-10-10', last_checked: '2026-10-12T00:00:00Z',
  parent_id: null, icon: null, color: null, hidden: false, check_tier: 'active', check_due: false, check_reason: 'cadence', ...over,
});
const range = { start: '2026-10-01', end: '2026-10-31' };

describe('advisorReasons', () => {
  it('is empty when every account is checked and nothing is uncategorised', () => {
    expect(advisorReasons([acc({})], [], range)).toEqual([]);
  });
  it('lists the accounts the database marks as due, and uncategorised entries', () => {
    const accounts = [
      acc({ account_id: 'm', account_name: 'moved', check_tier: 'occasional', check_due: true, check_reason: 'moved' }),
      acc({ account_id: 'o', account_name: 'old', check_due: true }),
      acc({ account_id: 'q', account_name: 'quiet', check_tier: 'dormant_empty', check_due: false, check_reason: null }),
      acc({ account_id: 'p', account_name: 'apartamento', subtype: 'property', check_tier: 'never', check_due: false, last_checked: null }),
      acc({ account_id: 'h', account_name: 'hidden', hidden: true, check_due: true }),
      acc({ account_id: 'c', account_name: 'cat', account_type: 'expense', last_checked: null }),
    ];
    const entries: DashboardEntry[] = [
      { date: '2026-10-02', amount_base: 13400, account_name: 'sem-categoria', account_type: 'expense', account_id: 'x' },
      { date: '2026-10-02', amount_base: -13400, account_name: 'nu-conta', account_type: 'asset', account_id: 'a' },
    ];
    const reasons = advisorReasons(accounts, entries, range);
    expect(reasons.map((r) => r.key)).toEqual(['check', 'uncategorised']);
    expect(reasons[0].label).toBe('2 contas para conferir');
    expect(reasons[0].detail).toBe('moved, old');
    expect(reasons[0].context).toContain('why: moved');
    expect(reasons[1].label).toBe('1 lançamento sem categoria');
    expect(reasons[1].context).toContain('13400.00');
  });
});
