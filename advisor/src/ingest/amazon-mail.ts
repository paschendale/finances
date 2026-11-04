/**
 * Amazon.com.br order mails ("Pedido: …" from auto-confirm@, "Confirmação de pagamento: …" from
 * payments-update@). Both carry the order number, the items (unit price and quantity) and the order
 * total; neither names the card. Prices are per unit and the total may differ from their sum
 * (discounts such as "Programe e Poupe", shipping), so the total is what the card is charged.
 */
export interface AmazonOrderItem {
  name: string;
  quantity: number;
  /** Unit price in BRL as shown */
  unit_price: number;
}

export interface AmazonOrder {
  order_ref: string;
  kind: 'order' | 'payment';
  items: AmazonOrderItem[];
  total: number | null;
  currency: 'BRL';
}

export const AMAZON_ORDER_SENDERS = ['auto-confirm@amazon.com.br', 'payments-update@amazon.com.br'];

export function isAmazonOrderMail(sender: string | null, subject: string): 'order' | 'payment' | null {
  const s = (sender ?? '').toLowerCase();
  if (s === 'auto-confirm@amazon.com.br' && /^pedido\b/i.test(subject.trim())) return 'order';
  if (s === 'payments-update@amazon.com.br' && /confirma[cç][aã]o de pagamento/i.test(subject)) return 'payment';
  return null;
}

/** "1,234.56" / "1.234,56" / "22.9" → number (the mails use a dot for decimals). */
export function parseAmazonAmount(s: string): number {
  const t = s.trim();
  if (/,\d{1,2}$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  return Number(t.replace(/,/g, ''));
}

export function parseAmazonOrderText(text: string, kind: 'order' | 'payment' = 'order'): AmazonOrder | null {
  const t = text.replace(/\r/g, '');
  const ref = t.match(/Pedido n[ºo°.]*\s*\n?\s*(\d{3}-\d{7}-\d{7})/i) ?? t.match(/orderID=(\d{3}-\d{7}-\d{7})/);
  if (!ref) return null;
  const items: AmazonOrderItem[] = [];
  const itemRe = /^\*\s+(.+?)\s*\n\s*Quantidade:\s*(\d+)\s*\n\s*([\d.,]+)\s*BRL/gm;
  for (const m of t.matchAll(itemRe)) {
    const unit = parseAmazonAmount(m[3]!);
    if (Number.isFinite(unit)) items.push({ name: m[1]!.trim(), quantity: Number(m[2]), unit_price: unit });
  }
  const tot = t.match(/^Total\s*\n\s*([\d.,]+)\s*BRL/m);
  const total = tot ? parseAmazonAmount(tot[1]!) : null;
  if (items.length === 0 && total === null) return null;
  return { order_ref: ref[1]!, kind, items, total: total !== null && Number.isFinite(total) ? total : null, currency: 'BRL' };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Card charges for one order: the whole total, or (when Amazon charged per seller or shipment) a
 * group of items. Returns the item indexes whose value, scaled by total/sum to absorb discounts and
 * shipping, adds up to `amount` within a cent per item; null when nothing fits.
 */
export function itemsForCharge(order: Pick<AmazonOrder, 'items' | 'total'>, amount: number): number[] | null {
  const n = order.items.length;
  if (n === 0) return null;
  const values = order.items.map((i) => i.unit_price * i.quantity);
  const sum = values.reduce((a, b) => a + b, 0);
  if (order.total !== null && Math.abs(order.total - amount) < 0.01) return values.map((_, i) => i);
  if (n > 12) return null;
  const scale = order.total !== null && sum > 0 ? order.total / sum : 1;
  let best: number[] | null = null;
  for (let mask = 1; mask < 1 << n; mask++) {
    const idx: number[] = [];
    let raw = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) (idx.push(i), (raw += values[i]!));
    // A part charge is either the items at list price or at the order's discount/shipping ratio.
    const tol = 0.01 * idx.length + 0.005;
    if (Math.abs(raw - amount) <= tol || Math.abs(raw * scale - amount) <= tol) {
      if (!best || idx.length < best.length) best = idx;
    }
  }
  return best;
}

/** Splits `amount` across items in proportion to their value; cents go to the largest item so the parts add up exactly. */
export function splitByItems(items: AmazonOrderItem[], amount: number): number[] {
  const values = items.map((i) => i.unit_price * i.quantity);
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) return items.map((_, i) => (i === 0 ? round2(amount) : 0));
  const parts = values.map((v) => round2((v / sum) * amount));
  const diff = round2(amount - parts.reduce((a, b) => a + b, 0));
  const big = values.indexOf(Math.max(...values));
  parts[big] = round2(parts[big]! + diff);
  return parts;
}
