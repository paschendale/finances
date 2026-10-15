import type { PlanEntry, PlanItem } from './advisor-api';

/** The asset/liability leg (prefer the outflow) and the category leg of a plan item. */
export function primaryLeg(item: Pick<PlanItem, 'entries'>): { asset: PlanEntry | null; category: PlanEntry | null; isTransfer: boolean } {
  const assets = item.entries.filter((e) => e.account_type === 'asset' || e.account_type === 'liability' || e.account_type === 'equity');
  const cats = item.entries.filter((e) => e.account_type === 'expense' || e.account_type === 'income');
  const asset = assets.find((e) => e.amount_base < 0) ?? assets[0] ?? null;
  return { asset, category: cats[0] ?? null, isTransfer: cats.length === 0 && assets.length >= 2 };
}

const SUBTYPE_LABEL: Record<string, string> = {
  checking: 'conta corrente',
  emergency: 'reserva',
  investments: 'investimento',
  liabilities: 'cartão / passivo',
  category: 'categoria',
  property: 'patrimônio (fora do dashboard)',
  loan: 'financiamento (fora do dashboard)',
};

/** Human label for items that do not move money: account creation and account changes. */
export function accountItemLabel(item: Pick<PlanItem, 'kind' | 'payload' | 'description'>): string | null {
  const p = item.payload as Record<string, unknown>;
  if (item.kind === 'account_create') {
    const sub = typeof p.subtype === 'string' ? ` · ${SUBTYPE_LABEL[p.subtype] ?? p.subtype}` : '';
    return `Nova conta ${String(p.name ?? '?')} (${String(p.type ?? '?')}${sub})`;
  }
  if (item.kind === 'account_update') {
    const fields = ['name', 'subtype', 'parent_id', 'icon', 'color', 'hidden'].filter((k) => p[k] !== undefined).map((k) => `${k} → ${k === 'subtype' && typeof p[k] === 'string' ? SUBTYPE_LABEL[p[k] as string] ?? String(p[k]) : String(p[k])}`);
    return `Alterar conta ${item.description ?? String(p.account_id ?? '').slice(0, 8)}: ${fields.join(', ')}`;
  }
  return null;
}

export const isAccountItem = (kind: PlanItem['kind']) => kind === 'account_create' || kind === 'account_update';
