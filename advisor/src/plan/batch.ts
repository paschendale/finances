import type { AppContext } from '../context.js';
import { many, maybeOne } from '../db/client.js';
import type { PlanEntry, Statement, StatementLine } from '../db/types.js';
import { getStatement, updateStatement } from '../db/repo/statements.js';
import { appendPlanItems, createPlan, updatePlan, type PlanItemInput } from '../db/repo/plans.js';
import { findNoteByPrefix } from '../db/repo/misc.js';
import { matchLines } from '../ingest/match.js';
import { accountConversationTitle } from '../gmail/grouping.js';
import { entriesInPeriod, loadAccounts } from './reconcile.js';
import { round2, validatePlanItems, type PlanItemInputShape } from './schema.js';
import { scoped } from '../log.js';

const log = scoped('plan.batch');

/** A line the system could not vouch for, with everything the assistant needs to decide. */
export interface DigestLine {
  hash: string;
  date: string;
  amount: number;
  raw: string;
  description_hint: string;
  alias: string | null;
  installment: StatementLine['installment'] | null;
  likely_duplicate_of: string | null;
  candidates: Array<{ category_id: string; category_name: string; confidence: number }>;
}

export interface DigestStatement {
  id: string;
  filename: string;
  period_start: string | null;
  period_end: string | null;
  opening_balance: number | null;
  closing_balance: number | null;
  line_count: number;
  already_in_ledger: number;
  auto_matched: number;
  amount_fixes: number;
  unmatched: DigestLine[];
  /** Ledger entries of the period on the account that no line vouches for: duplicates, hand entries without a line, or wrong account */
  outstanding: Array<{ transaction_id: string; date: string; description: string; amount_base: number }>;
}

export interface BatchDigest {
  plan_id: string;
  title: string;
  account_id: string;
  account_name: string | null;
  statements: DigestStatement[];
  auto_items: number;
}

/** Re-runs the matcher for a statement against its ledger account and stores the flags. */
export async function rematchStatement(ctx: AppContext, statement: Statement, accountId: string): Promise<Statement> {
  const lines = await matchLines(ctx.db, statement.lines ?? [], accountId);
  const updated = await updateStatement(ctx.db, statement.id, { account_id: accountId, lines });
  if (statement.institution && statement.account_ref) await rememberAccountRef(ctx, statement.institution, statement.account_ref, accountId);
  return updated;
}

async function rememberAccountRef(ctx: AppContext, institution: string, accountRef: string, accountId: string): Promise<void> {
  const key = `statement_source=${institution}:${accountRef}`;
  const notes = await findNoteByPrefix(ctx.db, 'account', key);
  if (notes.some((n) => n.ref_id === accountId)) return;
  await ctx.db.query('INSERT INTO advisor_notes (scope, ref_id, note, created_by) VALUES ($1, $2, $3, $4)', ['account', accountId, key, 'advisor']);
}

/**
 * Prepares one plan for a batch of statements of one account: vouches identical lines, drafts the
 * automatic cent corrections as `update` items, and returns what is left for the assistant (the
 * unmatched lines with candidates, and the ledger entries of each period no line vouches for).
 */
export async function prepareBatch(ctx: AppContext, input: { conversationId: string; statementIds: string[]; accountId?: string | null; createdBy: string | null }): Promise<BatchDigest> {
  const statements: Statement[] = [];
  for (const id of input.statementIds) {
    const st = await getStatement(ctx.db, id);
    if (!st) throw new Error(`statement ${id} not found`);
    if (st.conversation_id !== input.conversationId) throw new Error(`statement ${id} belongs to another conversation (statement_claim it first)`);
    statements.push(st);
  }
  if (statements.length === 0) throw new Error('no statements');
  const accountId = input.accountId ?? statements.find((s) => s.account_id)?.account_id ?? null;
  if (!accountId) throw new Error('the ledger account is not known: resolve it (match_account, note_list) and call again with account_id');
  const accounts = await loadAccounts(ctx.db);
  const account = accounts.get(accountId);
  if (!account) throw new Error(`account ${accountId} not found`);
  if (account.type !== 'asset' && account.type !== 'liability') throw new Error(`account ${account.full_name} is a ${account.type}; a statement belongs to an asset or liability account`);

  const matched: Statement[] = [];
  for (const st of statements) matched.push(await rematchStatement(ctx, st, accountId));
  matched.sort((a, b) => (a.period_start ?? '9999').localeCompare(b.period_start ?? '9999') || a.created_at.localeCompare(b.created_at));

  const span = accountConversationTitle({ institution: null, kind: matched[0]!.kind }, matched).replace(/^.*? · /, '');
  const title = `Conferência ${account.full_name.split(':').pop()}${span && span !== 'Extrato conta' ? ` · ${span}` : ''}`.slice(0, 200);
  const plan = await createPlan(ctx.db, { conversation_id: input.conversationId, statement_ids: matched.map((s) => s.id), title, created_by: input.createdBy ?? 'advisor' });
  await ctx.db.query(`UPDATE advisor_statements SET status = 'planned' WHERE id = ANY($1::uuid[]) AND status IN ('received','parsed')`, [matched.map((s) => s.id)]);

  // Automatic corrections: the statement amount wins on a two-leg hand entry that differs by cents.
  const autoItems: PlanItemInput[] = [];
  for (const st of matched) {
    for (const line of st.lines ?? []) {
      if (!line.amount_fix) continue;
      const item = await amountFixItem(ctx, st, line);
      if (item) autoItems.push(item);
    }
  }
  const issues = validatePlanItems(autoItems as unknown as PlanItemInputShape[], accounts);
  const bad = new Set(issues.map((i) => i.index));
  if (bad.size) log.warn({ planId: plan.id, issues }, 'automatic corrections dropped');
  const kept = autoItems.filter((_, i) => !bad.has(i));
  if (kept.length) await appendPlanItems(ctx.db, plan.id, kept);

  // An entry vouched by any period of the batch is not outstanding in another (card dates straddle bills).
  const vouchedAll = new Set(matched.flatMap((s) => (s.lines ?? []).map((l) => l.ledger_transaction_id).filter((x): x is string => Boolean(x))));
  const digest: DigestStatement[] = [];
  for (const st of matched) {
    const lines = st.lines ?? [];
    const vouchedTx = vouchedAll;
    const period = st.period_start && st.period_end ? await entriesInPeriod(ctx.db, accountId, st.period_start, st.period_end) : [];
    digest.push({
      id: st.id,
      filename: st.filename,
      period_start: st.period_start,
      period_end: st.period_end,
      opening_balance: st.opening_balance,
      closing_balance: st.closing_balance,
      line_count: lines.length,
      already_in_ledger: lines.filter((l) => l.already_in_ledger).length,
      auto_matched: lines.filter((l) => l.auto_matched).length,
      amount_fixes: lines.filter((l) => l.amount_fix).length,
      unmatched: lines
        .filter((l) => !l.already_in_ledger && !l.auto_matched && !l.amount_fix)
        .map((l) => ({
          hash: l.hash,
          date: l.date,
          amount: l.amount,
          raw: l.raw,
          description_hint: l.description_hint,
          alias: l.alias?.canonical_description ?? null,
          installment: l.installment ?? null,
          likely_duplicate_of: l.likely_duplicate ? (l.duplicate_candidate_id ?? null) : null,
          candidates: (l.candidates ?? []).slice(0, 2).map((c) => ({ category_id: c.category_id, category_name: c.category_name, confidence: c.confidence })),
        })),
      outstanding: period.filter((e) => !vouchedTx.has(e.transaction_id)).map((e) => ({ transaction_id: e.transaction_id, date: e.date, description: e.description, amount_base: e.amount_base })),
    });
  }
  await updatePlan(ctx.db, plan.id, {
    result: {
      digest: {
        account_id: accountId,
        statements: digest.map((d) => ({ id: d.id, filename: d.filename, period_start: d.period_start, period_end: d.period_end, line_count: d.line_count, auto_matched: d.auto_matched + d.already_in_ledger, amount_fixes: d.amount_fixes, unmatched: d.unmatched.length, outstanding: d.outstanding.length })),
      },
    },
  });
  log.info({ planId: plan.id, statements: matched.length, autoItems: kept.length, unmatched: digest.reduce((n, d) => n + d.unmatched.length, 0) }, 'batch prepared');
  return { plan_id: plan.id, title, account_id: accountId, account_name: account.full_name, statements: digest, auto_items: kept.length };
}

async function amountFixItem(ctx: AppContext, st: Statement, line: StatementLine): Promise<PlanItemInput | null> {
  const fix = line.amount_fix!;
  const tx = await maybeOne<{ id: string; date: string; description: string }>(ctx.db, 'SELECT id, date::text, description FROM transactions WHERE id = $1', [fix.transaction_id]);
  if (!tx) return null;
  const legs = await many<{ account_id: string; amount: number; currency: string; exchange_rate: number; amount_base: number }>(ctx.db, 'SELECT account_id, amount, currency, exchange_rate, amount_base FROM entries WHERE transaction_id = $1 ORDER BY amount_base', [fix.transaction_id]);
  if (legs.length !== 2 || legs.some((l) => Number(l.exchange_rate) !== 1 || l.currency !== (line.currency || 'BRL'))) return null;
  const accountLeg = legs.find((l) => l.account_id === st.account_id);
  const otherLeg = legs.find((l) => l.account_id !== st.account_id);
  if (!accountLeg || !otherLeg) return null;
  const entries: PlanEntry[] = [
    { account_id: accountLeg.account_id, amount: round2(line.amount), currency: line.currency || 'BRL', exchange_rate: 1, amount_base: round2(line.amount) },
    { account_id: otherLeg.account_id, amount: round2(-line.amount), currency: line.currency || 'BRL', exchange_rate: 1, amount_base: round2(-line.amount) },
  ];
  return {
    kind: 'update',
    transaction_id: tx.id,
    date: tx.date.slice(0, 10),
    description: tx.description,
    entries,
    payload: { auto: 'amount_fix', ledger_amount: fix.ledger_amount, statement_amount: line.amount },
    source_ref: { statement_id: st.id, line_hash: line.hash, ...(line.fitid ? { fitid: line.fitid } : {}) },
    confidence: 0.95,
    rationale: `Valor corrigido pelo extrato (R$ ${Math.abs(fix.ledger_amount).toFixed(2).replace('.', ',')} → R$ ${Math.abs(line.amount).toFixed(2).replace('.', ',')}).`,
  };
}
