import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many, maybeOne } from '../db/client.js';
import { claimEvent, recordClaudeCall, setEventOutcome } from '../db/repo/misc.js';
import { parseCardSms, type SmsCharge } from '../ingest/itau-sms.js';
import { runSingleShot } from '../claude/runner.js';
import { routineGate } from './scheduler.js';
import { resolveStatementAccount } from './ingest-statement.js';
import { fmtBRL, fmtDay } from '../discord/poster.js';
import { scoped } from '../log.js';

const log = scoped('sms');

/**
 * Card purchase alerts forwarded from the phone. The household chose (2026-11-04) to record them
 * straight away, without a plan: Claude picks the name and category, the purchase goes on the card
 * account, Discord says what was recorded and a reply there corrects it. When the card statement
 * arrives, `batch_prepare` vouches these entries like any hand entry (same amount, within 3 days).
 */

export interface SmsInput {
  text: string;
  sender?: string | null;
  /** When the phone received it (ISO); defaults to now */
  received_at?: string | null;
}

export type SmsOutcome =
  | { status: 'recorded'; transaction_id: string; description: string; category: string; amount: number; date: string }
  | { status: 'already_recorded'; transaction_id: string }
  | { status: 'duplicate_message' }
  | { status: 'ignored'; reason: string }
  | { status: 'needs_attention'; reason: string };

const classifySchema = z.object({
  is_charge: z.boolean(),
  amount: z.number().nullable(),
  date: z.string().nullable(),
  merchant: z.string().nullable(),
  description: z.string(),
  category_id: z.string().nullable(),
  confident: z.boolean(),
  reason: z.string(),
});
type Classification = z.infer<typeof classifySchema>;

interface Category {
  id: string;
  full_name: string;
}

interface Candidate {
  category_id: string | null;
  category_name: string | null;
  canonical_description: string | null;
  confidence: number;
}

/** The same text forwarded twice (automation retried, phone re-delivered) is one event. */
export function smsEventId(text: string, receivedAt: string | null | undefined): string {
  const day = (receivedAt ?? '').slice(0, 10);
  return createHash('sha256').update(`${text.replace(/\s+/g, ' ').trim()}|${day}`).digest('hex').slice(0, 32);
}

/** Title Case fallback name when Claude is not available: "NETFLIX.COM" → "Netflix". */
export function fallbackDescription(merchant: string): string {
  const s = merchant
    .replace(/\.(com|net|br)(\.br)?\b/gi, '')
    .replace(/\b(ltda|me|sa|s\/a|eireli)\b\.?/gi, '')
    .replace(/[*_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return s.replace(/(^|\s)\S/g, (c) => c.toUpperCase()) || merchant;
}

export async function ingestSms(ctx: AppContext, input: SmsInput): Promise<SmsOutcome> {
  const text = input.text.trim();
  const eventId = smsEventId(text, input.received_at);
  const fresh = await claimEvent(ctx.db, { source: 'sms', external_id: eventId, kind: 'card_alert', payload: { text, sender: input.sender ?? null, received_at: input.received_at ?? null } });
  if (!fresh) return { status: 'duplicate_message' };
  const done = async (o: SmsOutcome): Promise<SmsOutcome> => {
    await setEventOutcome(ctx.db, 'sms', eventId, JSON.stringify(o));
    log.info({ eventId, ...o }, 'sms handled');
    return o;
  };

  try {
    const now = input.received_at ? new Date(input.received_at) : new Date();
    const parsed = parseCardSms(text, Number.isNaN(now.getTime()) ? new Date() : now, ctx.config.TZ);

    const categories = await many<Category>(
      ctx.db,
      `SELECT h.id, h.full_name FROM account_names_hierarchical h JOIN accounts a ON a.id = h.id
       WHERE a.type = 'expense' AND a.hidden = false ORDER BY h.full_name`,
    );
    const accountId = await resolveStatementAccount(ctx, parsed?.institution ?? 'itau', 'card', parsed?.card_last4 ?? null);
    const candidates = await many<Candidate>(
      ctx.db,
      `SELECT category_id, category_name, canonical_description, confidence::float AS confidence
       FROM classify_candidates($1, $2, $3::uuid, $4::date, NULL, $5, 3)`,
      [parsed?.merchant ?? text, parsed ? -parsed.amount : null, accountId, parsed?.date ?? null, parsed?.merchant ?? text],
    ).catch((err) => {
      log.warn({ err: (err as Error).message }, 'classify_candidates failed');
      return [] as Candidate[];
    });

    const cls = await classify(ctx, { sms: text, parsed, candidates, categories });

    // The parser only recognises approved purchases; Claude decides for formats it does not know.
    if (!parsed && cls && !cls.is_charge) return done({ status: 'ignored', reason: cls.reason });
    if (!parsed && !cls) {
      await notifyAttention(ctx, eventId, text, 'Não consegui ler esta mensagem do cartão.');
      return done({ status: 'needs_attention', reason: 'unreadable and Claude unavailable' });
    }

    // The amount and date come from the parser whenever it read the message; Claude only fills them for unknown formats.
    const amount = parsed?.amount ?? cls?.amount ?? null;
    const date = parsed?.date ?? (cls?.date && /^\d{4}-\d{2}-\d{2}$/.test(cls.date) ? cls.date : null);
    const merchant = parsed?.merchant ?? cls?.merchant ?? text.slice(0, 60);
    if (!amount || amount <= 0 || !date) {
      await notifyAttention(ctx, eventId, text, 'Não consegui ler o valor ou a data desta compra.');
      return done({ status: 'needs_attention', reason: 'no amount or date' });
    }
    if (!accountId) {
      await notifyAttention(ctx, eventId, text, `Não sei qual conta é o cartão${parsed?.card_last4 ? ` final ${parsed.card_last4}` : ''}. Me diga aqui qual é.`);
      return done({ status: 'needs_attention', reason: 'card account unknown' });
    }

    const existing = await findExisting(ctx, accountId, amount, date, parsed?.time ?? null);
    if (existing) {
      await ctx.notifier.notice({
        key: `sms:${eventId}`,
        title: `${fallbackDescription(merchant)} · ${fmtBRL(amount)}`,
        status: '✅ Já estava registrado',
        lines: [`${existing.description} em ${fmtDay(existing.date)}`],
      });
      return done({ status: 'already_recorded', transaction_id: existing.id });
    }

    const fallbackCategory = candidates[0] && candidates[0].confidence >= 0.6 ? candidates[0].category_id : null;
    const semCategoria = categories.find((c) => c.full_name === 'sem-categoria')?.id ?? null;
    const categoryId = [cls?.category_id, fallbackCategory, semCategoria].find((id) => id && categories.some((c) => c.id === id)) ?? null;
    if (!categoryId) {
      await notifyAttention(ctx, eventId, text, 'Não achei uma categoria para esta compra.');
      return done({ status: 'needs_attention', reason: 'no category' });
    }
    const category = categories.find((c) => c.id === categoryId)!;
    const description = (cls?.description?.trim() || candidates[0]?.canonical_description || fallbackDescription(merchant)).slice(0, 120);

    const res = await ctx.pg.rpc<{ id: string }>('create_transaction', {
      p_date: date,
      p_description: description,
      p_entries: [
        { account_id: accountId, amount: -amount, currency: 'BRL', exchange_rate: 1, amount_base: -amount },
        { account_id: categoryId, amount, currency: 'BRL', exchange_rate: 1, amount_base: amount },
      ],
      p_metadata: {
        source: 'sms',
        sms_event_id: eventId,
        sms: { raw: text, merchant, time: parsed?.time ?? null, card_last4: parsed?.card_last4 ?? null, card_name: parsed?.card_name ?? null },
        classified_by: cls ? 'claude' : 'system',
        recorded_at: new Date().toISOString(),
      },
    });
    if (parsed?.card_last4) await rememberCard(ctx, parsed, accountId);

    const card = await maybeOne<{ full_name: string }>(ctx.db, 'SELECT full_name FROM account_names_hierarchical WHERE id = $1', [accountId]);
    await ctx.notifier.notice({
      key: `sms:${eventId}`,
      title: `${description} · ${fmtBRL(amount)}`,
      status: `💳 Registrado em ${category.full_name.replace(/:/g, ' › ')}${cls && !cls.confident ? ' (confira)' : ''}`,
      lines: [`${card?.full_name ?? 'Cartão'} · ${fmtDay(date)}${parsed?.time ? ` às ${parsed.time.replace(':', 'h')}` : ''}`, 'Errado? Responda aqui com o certo.'],
      context:
        `This thread is about a card purchase recorded automatically from a bank SMS: transaction ${res.id} on ${date}, "${description}", ${amount.toFixed(2)} BRL on account ${accountId}, category ${category.full_name} (${categoryId}). ` +
        `SMS text: "${text}". If the person says the name, category, value or date is wrong, draft a plan with one update item for transaction ${res.id}; if they say it is not theirs or a duplicate, draft a delete item. Write to them in plain Portuguese.`,
    });
    return done({ status: 'recorded', transaction_id: res.id, description, category: category.full_name, amount, date });
  } catch (err) {
    log.error({ err, eventId }, 'sms ingest failed');
    // Let the phone retry: forget the event so the same text is processed again.
    await ctx.db.query('DELETE FROM advisor_events WHERE source = $1 AND external_id = $2', ['sms', eventId]).catch(() => undefined);
    throw err;
  }
}

/**
 * A purchase already in the ledger on that card: same value within a day, typed by hand or from
 * the same SMS time. Two equal purchases on one day with different SMS times are both recorded.
 */
async function findExisting(ctx: AppContext, accountId: string, amount: number, date: string, time: string | null): Promise<{ id: string; description: string; date: string } | null> {
  const rows = await many<{ id: string; description: string; date: string; source: string | null; sms_time: string | null }>(
    ctx.db,
    `SELECT t.id, t.description, t.date::text AS date, t.metadata->>'source' AS source, t.metadata->'sms'->>'time' AS sms_time
     FROM transactions t JOIN entries e ON e.transaction_id = t.id
     WHERE e.account_id = $1 AND abs(e.amount_base + $2) < 0.005 AND t.date BETWEEN $3::date - 1 AND $3::date + 1
     ORDER BY abs(t.date - $3::date)`,
    [accountId, amount, date],
  );
  return rows.find((r) => r.source !== 'sms' || r.sms_time === time || !time) ?? null;
}

async function rememberCard(ctx: AppContext, p: SmsCharge, accountId: string): Promise<void> {
  const key = `statement_source=${p.institution}:${p.card_last4}`;
  const exists = await maybeOne(ctx.db, 'SELECT id FROM advisor_notes WHERE scope = $1 AND note LIKE $2', ['account', `${key}%`]);
  if (!exists) await ctx.db.query('INSERT INTO advisor_notes (scope, ref_id, note, created_by) VALUES ($1, $2, $3, $4)', ['account', accountId, `${key} kind=card`, 'advisor']);
}

async function notifyAttention(ctx: AppContext, eventId: string, text: string, why: string): Promise<void> {
  await ctx.notifier.notice({
    key: `sms:${eventId}`,
    title: 'Mensagem do cartão',
    status: `⚠️ ${why}`,
    lines: [text.slice(0, 180)],
    context: `This thread is about a bank SMS the system could not record on its own: "${text}". Reason: ${why} Help the person and, if it is a purchase, draft a plan with one create item. Write in plain Portuguese.`,
  });
}

/** One Sonnet call per purchase (routine, so it respects the usage gate); null when unavailable. */
async function classify(ctx: AppContext, input: { sms: string; parsed: SmsCharge | null; candidates: Candidate[]; categories: Category[] }): Promise<Classification | null> {
  const gate = await routineGate(ctx).catch(() => ({ open: false, reason: 'gate check failed' }));
  if (!gate.open) {
    log.info({ reason: gate.reason }, 'usage gate closed; classifying without Claude');
    return null;
  }
  const system = await fs.readFile(path.join(ctx.promptsDir, 'classify-sms.system.md'), 'utf8');
  const schema = JSON.parse(await fs.readFile(path.join(ctx.promptsDir, 'classify-sms.schema.json'), 'utf8')) as Record<string, unknown>;
  const started = new Date();
  try {
    const r = await runSingleShot({ bin: ctx.config.CLAUDE_BIN, systemPrompt: system, jsonSchema: schema, input, model: ctx.config.ROUTINE_MODEL, effort: 'low', timeoutMs: ctx.config.SINGLE_SHOT_TIMEOUT_MS });
    await recordClaudeCall(ctx.db, { conversation_id: null, claude_session_id: r.sessionId, mode: 'single', model: ctx.config.ROUTINE_MODEL, started_at: started, duration_ms: r.durationMs, exit_code: r.exitCode, usage: r.usage, cost_usd: r.costUsd, error: null });
    const parsed = classifySchema.safeParse(r.value);
    if (parsed.success) return parsed.data;
    log.warn({ issues: parsed.error.issues }, 'classify-sms output invalid');
    return null;
  } catch (err) {
    await recordClaudeCall(ctx.db, { conversation_id: null, claude_session_id: null, mode: 'single', model: ctx.config.ROUTINE_MODEL, started_at: started, duration_ms: Date.now() - started.getTime(), exit_code: null, usage: null, cost_usd: null, error: (err as Error).message });
    log.warn({ err: (err as Error).message }, 'classify-sms failed; classifying without Claude');
    return null;
  }
}
