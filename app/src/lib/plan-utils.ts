import type { PlanEntry, PlanItem } from './advisor-api';

/** The asset/liability leg (prefer the outflow) and the category leg of a plan item. */
export function primaryLeg(item: Pick<PlanItem, 'entries'>): { asset: PlanEntry | null; category: PlanEntry | null; isTransfer: boolean } {
  const assets = item.entries.filter((e) => e.account_type === 'asset' || e.account_type === 'liability' || e.account_type === 'equity');
  const cats = item.entries.filter((e) => e.account_type === 'expense' || e.account_type === 'income');
  const asset = assets.find((e) => e.amount_base < 0) ?? assets[0] ?? null;
  return { asset, category: cats[0] ?? null, isTransfer: cats.length === 0 && assets.length >= 2 };
}
