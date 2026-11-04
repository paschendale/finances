import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many, maybeOne, one } from '../db/client.js';
import { getState, recordClaudeCall, setState } from '../db/repo/misc.js';
import { createConversation } from '../db/repo/conversations.js';
import { createPlan, replacePlanItems, updatePlan, type PlanItemInput } from '../db/repo/plans.js';
import { approveAndApply } from '../plan/apply.js';
import { itemsForCharge, splitByItems, type AmazonOrder, type AmazonOrderItem } from '../ingest/amazon-mail.js';
import { runSingleShot } from '../claude/runner.js';
import { routineGate } from './scheduler.js';
import { fmtBRL, fmtDay } from '../discord/poster.js';
import { scoped } from '../log.js';

const log = scoped('amazon');

/**
 * Amazon orders read from mail are matched to the card charges that paid for them; a charge the
 * household left generic ("Amazon", sem-categoria, or recorded from an SMS) is renamed
 * "Amazon - <item>" and split across the items' categories. Decided 2026-11-04: fixed automatically
 * through a plan the system approves (so cleared entries reopen and re-close as usual), entries the
 * household named are left alone, mixed orders are split by item.
 */

/** Charges are looked for from a day before the order until this many days after (Amazon charges on shipping). */
export const MATCH_WINDOW_DAYS = 20;
/** An order still without its charge after this many days is reported once. */
export const REPORT_AFTER_DAYS = 30;

export interface StoredOrder {
  id: string;
  order_ref: string;
  ordered_at: string;
  items: AmazonOrderItem[];
  total: number | null;
  status: 'open' | 'partial' | 'matched' | 'ignored';
  charges: Array<{ transaction_id: string; amount: number; items: number[]; action: 'enriched' | 'linked' | 'pending'; at: string }>;
  reported_at: string | null;
}

export interface ChargeRow {
  transaction_id: string;
  date: string;
  amount: number;
  money_account_id: string;
  currency: string;
  description: string;
  source: string | null;
  /** Expense legs: [{account_id, amount}] */
  legs: Array<{ account_id: string; amount: number }>;
}

export interface Assignment {
  order: StoredOrder;
  charge: ChargeRow;
  items: number[];
}

const dayDiff = (a: string, b: string) => (Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)) / 86_400_000;

/**
 * Pairs open orders with unclaimed charges: the whole order total first, else a group of the items
 * still unpaid (Amazon charges per seller or shipment). Oldest orders first, nearest charge first.
 */
export function assignCharges(orders: StoredOrder[], charges: ChargeRow[]): Assignment[] {
  const used = new Set<string>();
  const out: Assignment[] = [];
  for (const order of [...orders].sort((a, b) => a.ordered_at.localeCompare(b.ordered_at))) {
    const paid = new Set(order.charges.flatMap((c) => c.items));
    const remaining = order.items.map((_, i) => i).filter((i) => !paid.has(i));
    if (remaining.length === 0) continue;
    const near = charges
      .filter((c) => !used.has(c.transaction_id))
      .map((c) => ({ c, d: dayDiff(c.date, order.ordered_at) }))
      .filter(({ d }) => d >= -1 && d <= MATCH_WINDOW_DAYS)
      .sort((x, y) => Math.abs(x.d) - Math.abs(y.d));
    let left = remaining;
    for (const { c } of near) {
      if (left.length === 0) break;
      // Total only applies while nothing of the order is paid yet; otherwise the remaining items, scaled like the whole order.
      const sub = { items: left.map((i) => order.items[i]!), total: left.length === order.items.length ? order.total : scaledTotal(order, left) };
      const hit = itemsForCharge(sub, c.amount);
      if (!hit) continue;
      const items = hit.map((k) => left[k]!);
      used.add(c.transaction_id);
      out.push({ order, charge: c, items });
      left = left.filter((i) => !items.includes(i));
    }
  }
  return out;
}

function scaledTotal(order: StoredOrder, idx: number[]): number | null {
  if (order.total === null) return null;
  const value = (i: number) => order.items[i]!.unit_price * order.items[i]!.quantity;
  const sum = order.items.reduce((s, _, i) => s + value(i), 0);
  if (sum <= 0) return null;
  return Math.round(((idx.reduce((s, i) => s + value(i), 0) * order.total) / sum) * 100) / 100;
}

/** "Amazon", "AMAZON BR", "Amazon Marketplace", "Amazonmktplc*Loja": a name the household did not choose. */
export function isGenericAmazonName(description: string): boolean {
  return /^\s*(amazon|amzn)[\s.*]*(br|com|com\.br|marketplace|mktplc\S*|mktp\S*|prime|servi[cç]os)?(\s*\*\s*\S+)?\s*$/i.test(description) || /^\s*amazonmktplc\S*\s*$/i.test(description);
}

export async function upsertOrder(ctx: AppContext, order: AmazonOrder, orderedAt: Date, gmailMessageId: string | null): Promise<StoredOrder> {
  return one<StoredOrder>(
    ctx.db,
    `INSERT INTO merchant_orders (merchant, order_ref, ordered_at, items, total, gmail_message_ids)
     VALUES ('amazon', $1, $2, $3::jsonb, $4, $5::text[])
     ON CONFLICT (merchant, order_ref) DO UPDATE SET
       ordered_at = LEAST(merchant_orders.ordered_at, EXCLUDED.ordered_at),
       items = CASE WHEN jsonb_array_length(merchant_orders.items) = 0 OR $6 = 'order' THEN EXCLUDED.items ELSE merchant_orders.items END,
       total = COALESCE(CASE WHEN $6 = 'order' THEN EXCLUDED.total END, merchant_orders.total, EXCLUDED.total),
       gmail_message_ids = (SELECT array_agg(DISTINCT x) FROM unnest(merchant_orders.gmail_message_ids || EXCLUDED.gmail_message_ids) x),
       updated_at = now()
     RETURNING id, order_ref, ordered_at::text, items, total::float AS total, status, charges, reported_at::text`,
    [order.order_ref, orderedAt.toISOString(), JSON.stringify(order.items), order.total, gmailMessageId ? [gmailMessageId] : [], order.kind],
  );
}

async function loadOpenOrders(ctx: AppContext): Promise<StoredOrder[]> {
  return many<StoredOrder>(
    ctx.db,
    `SELECT id, order_ref, ordered_at::text, items, total::float AS total, status, charges, reported_at::text
     FROM merchant_orders WHERE merchant = 'amazon' AND status IN ('open', 'partial') AND ordered_at > now() - interval '120 days'`,
  );
}

/** Card/account charges that look like Amazon and no order has claimed yet. */
async function loadCandidateCharges(ctx: AppContext, since: string): Promise<ChargeRow[]> {
  return many<ChargeRow>(
    ctx.db,
    `WITH claimed AS (
       SELECT (c->>'transaction_id')::uuid AS id FROM merchant_orders o, jsonb_array_elements(o.charges) c WHERE c->>'action' <> 'pending'
     )
     SELECT t.id AS transaction_id, t.date::text AS date, (-m.amount)::float AS amount, m.account_id AS money_account_id, m.currency,
            t.description, t.metadata->>'source' AS source,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('account_id', x.account_id, 'amount', x.amount::float))
                      FROM entries x WHERE x.transaction_id = t.id AND x.id <> m.id), '[]'::jsonb) AS legs
     FROM transactions t
     JOIN entries m ON m.transaction_id = t.id
     JOIN accounts ma ON ma.id = m.account_id AND ma.type IN ('asset', 'liability')
     WHERE t.date >= $1::date AND m.amount < 0
       AND (SELECT count(*) FROM entries y JOIN accounts ya ON ya.id = y.account_id WHERE y.transaction_id = t.id AND ya.type IN ('asset', 'liability')) = 1
       AND (t.description ~* '(amazon|amzn)' OR t.metadata->'statement_line'->>'raw' ~* '(amazon|amzn)' OR t.metadata->'sms'->>'merchant' ~* '(amazon|amzn)')
       AND t.id NOT IN (SELECT id FROM claimed)`,
    [since],
  );
}

const classifySchema = z.object({
  purchases: z.array(z.object({ key: z.string(), description: z.string(), items: z.array(z.object({ index: z.number().int(), category_id: z.string() })), confident: z.boolean() })),
});

type Plan = { assignment: Assignment; mode: 'rename' | 'recategorise' };

export interface MatchSummary {
  matched: number;
  enriched: Array<{ transaction_id: string; description: string; amount: number; date: string; categories: string[] }>;
  linked: number;
  unpaid: Array<{ order_ref: string; ordered_at: string; items: string[]; missing: number }>;
  deferred: number;
}

/**
 * Matches open orders to charges and fixes the generic ones. Safe to run often: claimed charges are
 * recorded on the order and never taken twice.
 */
let running: Promise<unknown> = Promise.resolve();

/** Runs one at a time (a mail and the scheduler can both ask at once). */
export function matchAmazonOrders(ctx: AppContext, opts: { notify?: boolean } = {}): Promise<MatchSummary> {
  const next = running.then(() => matchOnce(ctx, opts));
  running = next.catch(() => undefined);
  return next;
}

async function matchOnce(ctx: AppContext, opts: { notify?: boolean }): Promise<MatchSummary> {
  const summary: MatchSummary = { matched: 0, enriched: [], linked: 0, unpaid: [], deferred: 0 };
  const orders = await loadOpenOrders(ctx);
  if (orders.length === 0) return summary;
  const since = orders.reduce((m, o) => (o.ordered_at < m ? o.ordered_at : m), orders[0]!.ordered_at).slice(0, 10);
  const charges = await loadCandidateCharges(ctx, new Date(Date.parse(since) - 86_400_000).toISOString().slice(0, 10));
  const assignments = assignCharges(orders, charges);
  summary.matched = assignments.length;

  const categories = await many<{ id: string; full_name: string }>(
    ctx.db,
    `SELECT h.id, h.full_name FROM account_names_hierarchical h JOIN accounts a ON a.id = h.id WHERE a.type = 'expense' AND a.hidden = false ORDER BY h.full_name`,
  );
  const semCategoria = categories.find((c) => c.full_name === 'sem-categoria')?.id ?? null;
  const work: Plan[] = [];
  const linkOnly: Assignment[] = [];
  for (const a of assignments) {
    const c = a.charge;
    const uncategorised = c.legs.length > 0 && c.legs.every((l) => l.account_id === semCategoria);
    const fromSms = c.source === 'sms';
    if (c.currency !== 'BRL') linkOnly.push(a);
    else if (uncategorised || fromSms) work.push({ assignment: a, mode: 'recategorise' });
    else if (isGenericAmazonName(c.description)) work.push({ assignment: a, mode: 'rename' });
    else linkOnly.push(a);
  }

  for (const a of linkOnly) await recordCharge(ctx, a, 'linked');
  summary.linked = linkOnly.length;

  if (work.length > 0) {
    const cls = await classify(ctx, work, categories);
    if (!cls) {
      summary.deferred = work.length; // tried again on the next tick
    } else {
      const items: PlanItemInput[] = [];
      const done: Array<{ p: Plan; description: string; categories: string[] }> = [];
      for (const p of work) {
        const a = p.assignment;
        const key = a.charge.transaction_id;
        const r = cls.purchases.find((x) => x.key === key);
        if (!r) continue;
        const bought = a.items.map((i) => a.order.items[i]!);
        const description = r.description.trim().slice(0, 200) || `Amazon - ${bought[0]!.name.slice(0, 40)}`;
        let legs: Array<{ account_id: string; amount: number }>;
        if (p.mode === 'recategorise') {
          const parts = splitByItems(bought, a.charge.amount);
          const byCat = new Map<string, number>();
          a.items.forEach((idx, k) => {
            const chosen = r.items.find((x) => x.index === idx)?.category_id;
            const cat = chosen && categories.some((c) => c.id === chosen) ? chosen : (semCategoria ?? a.charge.legs[0]!.account_id);
            byCat.set(cat, Math.round(((byCat.get(cat) ?? 0) + parts[k]!) * 100) / 100);
          });
          legs = [...byCat.entries()].map(([account_id, amount]) => ({ account_id, amount }));
        } else {
          legs = a.charge.legs;
        }
        const entries = [
          { account_id: a.charge.money_account_id, amount: -a.charge.amount, currency: 'BRL', exchange_rate: 1, amount_base: -a.charge.amount },
          ...legs.map((l) => ({ account_id: l.account_id, amount: l.amount, currency: 'BRL', exchange_rate: 1, amount_base: l.amount })),
        ];
        items.push({
          kind: 'update',
          transaction_id: key,
          date: a.charge.date,
          description,
          entries,
          confidence: r.confident ? 0.9 : 0.6,
          rationale: `Pedido Amazon ${a.order.order_ref}: ${bought.map((b) => `${b.quantity}× ${b.name}`).join('; ')}`.slice(0, 1900),
          payload: { amazon_order: a.order.order_ref },
        });
        done.push({ p, description, categories: legs.map((l) => categories.find((c) => c.id === l.account_id)?.full_name ?? '?') });
      }
      if (items.length > 0) {
        const applied = await applyAutomatically(ctx, items);
        for (const d of done) {
          const ok = applied.has(d.p.assignment.charge.transaction_id);
          await recordCharge(ctx, d.p.assignment, ok ? 'enriched' : 'linked');
          if (ok) summary.enriched.push({ transaction_id: d.p.assignment.charge.transaction_id, description: d.description, amount: d.p.assignment.charge.amount, date: d.p.assignment.charge.date, categories: d.categories });
        }
      }
    }
  }

  // Orders with items nobody paid for after a while: report once.
  const stale = await many<StoredOrder>(
    ctx.db,
    `SELECT id, order_ref, ordered_at::text, items, total::float AS total, status, charges, reported_at::text FROM merchant_orders
     WHERE merchant = 'amazon' AND status IN ('open', 'partial') AND reported_at IS NULL AND ordered_at < now() - make_interval(days => $1)`,
    [REPORT_AFTER_DAYS],
  );
  for (const o of stale) {
    const paid = new Set(o.charges.flatMap((c) => c.items));
    const missing = o.items.filter((_, i) => !paid.has(i));
    summary.unpaid.push({ order_ref: o.order_ref, ordered_at: o.ordered_at, items: missing.map((m) => m.name), missing: Math.round(missing.reduce((s, m) => s + m.unit_price * m.quantity, 0) * 100) / 100 });
  }

  if (opts.notify !== false) await notify(ctx, summary);
  if (stale.length) await ctx.db.query('UPDATE merchant_orders SET reported_at = now() WHERE id = ANY($1::uuid[])', [stale.map((s) => s.id)]);
  log.info({ matched: summary.matched, enriched: summary.enriched.length, linked: summary.linked, deferred: summary.deferred, unpaid: summary.unpaid.length }, 'amazon orders matched');
  return summary;
}

async function recordCharge(ctx: AppContext, a: Assignment, action: 'enriched' | 'linked'): Promise<void> {
  await ctx.db.query(
    `UPDATE merchant_orders SET
       charges = charges || jsonb_build_array(jsonb_build_object('transaction_id', $2::text, 'amount', $3::numeric, 'items', $4::jsonb, 'action', $5::text, 'at', now())),
       status = CASE WHEN (SELECT count(DISTINCT i) FROM jsonb_array_elements(charges || jsonb_build_array(jsonb_build_object('items', $4::jsonb))) c, jsonb_array_elements(c->'items') i) >= jsonb_array_length(items)
                     THEN 'matched' ELSE 'partial' END,
       updated_at = now()
     WHERE id = $1`,
    [a.order.id, a.charge.transaction_id, a.charge.amount, JSON.stringify(a.items), action],
  );
  // Keep the in-memory order current for later assignments of the same run.
  a.order.charges.push({ transaction_id: a.charge.transaction_id, amount: a.charge.amount, items: a.items, action, at: new Date().toISOString() });
}

/** One system conversation holds the automatic Amazon plans, so every change stays reviewable. */
async function amazonConversation(ctx: AppContext): Promise<string> {
  const row = await maybeOne<{ id: string }>(ctx.db, `SELECT id FROM advisor_conversations WHERE channel = 'system' AND external_ref = 'amazon' ORDER BY created_at LIMIT 1`);
  if (row) return row.id;
  return (await createConversation(ctx.db, { channel: 'system', title: 'Compras na Amazon', external_ref: 'amazon', created_by: 'amazon' })).id;
}

async function applyAutomatically(ctx: AppContext, items: PlanItemInput[]): Promise<Set<string>> {
  const conversationId = await amazonConversation(ctx);
  const plan = await createPlan(ctx.db, { conversation_id: conversationId, title: `Amazon: ${items.length} compra${items.length === 1 ? '' : 's'} nomeada${items.length === 1 ? '' : 's'}`, created_by: 'amazon' });
  await replacePlanItems(ctx.db, plan.id, items);
  const ready = await updatePlan(ctx.db, plan.id, { status: 'pending_approval', summary: 'Nomes e categorias tirados dos e-mails de pedido da Amazon (gravado automaticamente).' });
  const res = await approveAndApply(ctx, plan.id, { actor: 'amazon', version: ready.version });
  return new Set(res.items.filter((i) => i.status === 'applied' && i.transaction_id).map((i) => i.transaction_id!));
}

async function classify(ctx: AppContext, work: Plan[], categories: Array<{ id: string; full_name: string }>): Promise<z.infer<typeof classifySchema> | null> {
  const gate = await routineGate(ctx).catch(() => ({ open: false, reason: 'gate check failed', usage: null }));
  if (!gate.open && gate.usage) {
    log.info({ reason: gate.reason }, 'usage gate closed; amazon naming deferred');
    return null;
  }
  const examples = await many<{ description: string; categories: string }>(
    ctx.db,
    `SELECT t.description, string_agg(h.full_name, ', ') AS categories FROM transactions t
     JOIN entries e ON e.transaction_id = t.id JOIN account_names_hierarchical h ON h.id = e.account_id JOIN accounts a ON a.id = e.account_id
     WHERE t.description ILIKE 'Amazon - %' AND a.type = 'expense' GROUP BY t.id, t.description, t.date ORDER BY t.date DESC LIMIT 40`,
  );
  const input = {
    purchases: work.map((p) => ({
      key: p.assignment.charge.transaction_id,
      current_description: p.assignment.charge.description,
      items: p.assignment.items.map((i) => {
        const it = p.assignment.order.items[i]!;
        return { index: i, name: it.name, quantity: it.quantity, value: Math.round(it.unit_price * it.quantity * 100) / 100 };
      }),
    })),
    examples,
    categories,
  };
  const system = await fs.readFile(path.join(ctx.promptsDir, 'classify-amazon.system.md'), 'utf8');
  const schema = JSON.parse(await fs.readFile(path.join(ctx.promptsDir, 'classify-amazon.schema.json'), 'utf8')) as Record<string, unknown>;
  const started = new Date();
  try {
    const r = await runSingleShot({ bin: ctx.config.CLAUDE_BIN, systemPrompt: system, jsonSchema: schema, input, model: ctx.config.ROUTINE_MODEL, effort: 'low', timeoutMs: ctx.config.SINGLE_SHOT_TIMEOUT_MS });
    await recordClaudeCall(ctx.db, { conversation_id: null, claude_session_id: r.sessionId, mode: 'single', model: ctx.config.ROUTINE_MODEL, started_at: started, duration_ms: r.durationMs, exit_code: r.exitCode, usage: r.usage, cost_usd: r.costUsd, error: null });
    const parsed = classifySchema.safeParse(r.value);
    if (parsed.success) return parsed.data;
    log.warn({ issues: parsed.error.issues }, 'classify-amazon output invalid');
    return null;
  } catch (err) {
    await recordClaudeCall(ctx.db, { conversation_id: null, claude_session_id: null, mode: 'single', model: ctx.config.ROUTINE_MODEL, started_at: started, duration_ms: Date.now() - started.getTime(), exit_code: null, usage: null, cost_usd: null, error: (err as Error).message });
    log.warn({ err: (err as Error).message }, 'classify-amazon failed; deferred');
    return null;
  }
}

async function notify(ctx: AppContext, s: MatchSummary): Promise<void> {
  if (s.enriched.length === 0 && s.unpaid.length === 0) return;
  const cat = (c: string) => c.replace(/:/g, ' › ');
  const lines = s.enriched.slice(0, 4).map((e) => `${e.description.replace(/^Amazon - /, '')} · ${fmtBRL(e.amount)} → ${e.categories.map(cat).join(' + ')}`);
  if (s.enriched.length > 4) lines.push(`e mais ${s.enriched.length - 4}`);
  for (const u of s.unpaid.slice(0, 3)) lines.push(`Sem cobrança achada: ${u.items[0]?.slice(0, 40) ?? u.order_ref} (${fmtBRL(u.missing)}, pedido de ${fmtDay(u.ordered_at.slice(0, 10))})`);
  await ctx.notifier.notice({
    key: `amazon:${new Date().toISOString().slice(0, 13)}`,
    title: 'Compras na Amazon',
    status: s.enriched.length ? `🛒 ${s.enriched.length} compra${s.enriched.length === 1 ? '' : 's'} nomeada${s.enriched.length === 1 ? '' : 's'} pelo e-mail do pedido` : '🛒 Pedidos sem cobrança',
    lines: [...lines, 'Errado? Responda aqui.'],
    details: [
      ...s.enriched.map((e) => `${fmtDay(e.date)} · ${e.description} · ${fmtBRL(e.amount)} → ${e.categories.map(cat).join(' + ')}`),
      ...s.unpaid.map((u) => `Pedido de ${fmtDay(u.ordered_at.slice(0, 10))} sem cobrança: ${u.items.join('; ')} (${fmtBRL(u.missing)})`),
    ],
    context:
      `This thread reports Amazon purchases the system renamed and categorised from Amazon order mails: ${s.enriched.map((e) => `transaction ${e.transaction_id} "${e.description}" ${e.amount.toFixed(2)} BRL on ${e.date} → ${e.categories.join(' + ')}`).join('; ')}. ` +
      (s.unpaid.length ? `Orders with no card charge found: ${s.unpaid.map((u) => `${u.order_ref} (${u.ordered_at.slice(0, 10)}, ${u.items.join('; ')}, ${u.missing.toFixed(2)} BRL)`).join('; ')}. ` : '') +
      'If the person says a name or category is wrong, draft a plan with update items. Write in plain Portuguese.',
  });
}

/** One-off look back over the mailbox (run once per install; later mails arrive through the watcher). */
export async function backfillAmazonOrders(ctx: AppContext, days: number, fetchMail: (q: string) => Promise<Array<{ id: string; sender: string | null; subject: string; date: Date; text: string | null }>>, parse: (m: { sender: string | null; subject: string; text: string | null }) => AmazonOrder | null): Promise<{ orders: number }> {
  let orders = 0;
  for (const q of [`from:auto-confirm@amazon.com.br newer_than:${days}d`, `from:payments-update@amazon.com.br newer_than:${days}d`]) {
    for (const m of await fetchMail(q)) {
      const o = parse(m);
      if (!o) continue;
      await upsertOrder(ctx, o, m.date, m.id);
      orders++;
    }
  }
  await setState(ctx.db, 'amazon_backfill', { at: new Date().toISOString(), days, orders });
  return { orders };
}

export async function amazonBackfillDone(ctx: AppContext): Promise<boolean> {
  return (await getState(ctx.db, 'amazon_backfill')) !== null;
}
