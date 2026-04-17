import { describe, expect, it } from 'vitest';
import { isBalanceCheckStale } from './balanceCheckStale';

describe('isBalanceCheckStale', () => {
  it('treats null as stale', () => {
    expect(isBalanceCheckStale(null, new Date('2026-04-17T12:00:00Z'))).toBe(true);
  });

  it('is not stale when checked within the threshold', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    expect(isBalanceCheckStale('2026-04-11T12:00:01Z', now, 7)).toBe(false);
  });

  it('is stale when last check is at or before the cutoff instant', () => {
    const now = new Date('2026-04-17T12:00:00Z');
    expect(isBalanceCheckStale('2026-04-10T12:00:00Z', now, 7)).toBe(true);
  });
});
