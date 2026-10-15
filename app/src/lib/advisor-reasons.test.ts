import { describe, expect, it } from 'vitest';
import { advisorReasons } from './advisor-reasons';
import type { Account, DashboardEntry } from './api';

const acc = (over: Partial<Account>): Account => ({
  account_id: over.account_id ?? 'a', account_name: over.account_name ?? 'nu-conta', account_type: 'asset', subtype: 'checking',
  balance: 100, own_balance: 100, future_balance: 0, last_entry_date: '2026-10-10', last_checked: '2026-10-12T00:00:00Z',
  parent_id: null, icon: null, color: null, hidden: false, ...over,
});
const now = new Date('2026-10-15T12:00:00Z');
const range = { start: '2026-10-01', end: '2026-10-31' };

describe('advisorReasons', () => {
  it('is empty when every account is checked and nothing is uncategorised', () => {
    expect(advisorReasons([acc({})], [], range, now)).toEqual([]);
  });
  it('flags accounts that moved after their last check, stale accounts and uncategorised entries', () => {
    const accounts = [
      acc({ account_id: 'm', account_name: 'moved', last_entry_date: '2026-10-14', last_checked: '2026-10-12T00:00:00Z' }),
      acc({ account_id: 's', account_name: 'stale', last_entry_date: '2026-08-01', last_checked: '2026-08-10T00:00:00Z' }),
      acc({ account_id: 'h', account_name: 'hidden', hidden: true, last_checked: null }),
      acc({ account_id: 'c', account_name: 'cat', account_type: 'expense', last_checked: null }),
    ];
    const entries: DashboardEntry[] = [
      { date: '2026-10-02', amount_base: 13400, account_name: 'sem-categoria', account_type: 'expense', account_id: 'x' },
      { date: '2026-10-02', amount_base: -13400, account_name: 'nu-conta', account_type: 'asset', account_id: 'a' },
    ];
    const reasons = advisorReasons(accounts, entries, range, now);
    expect(reasons.map((r) => r.key)).toEqual(['moved', 'stale', 'uncategorised']);
    expect(reasons[0].detail).toBe('moved');
    expect(reasons[2].label).toBe('1 lançamento sem categoria');
    expect(reasons[2].context).toContain('13400.00');
  });
});
