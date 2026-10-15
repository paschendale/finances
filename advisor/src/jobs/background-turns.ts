import type { AppContext } from '../context.js';
import { many } from '../db/client.js';
import type { Statement } from '../db/types.js';
import { BATCH_STEPS, buildIngestMessage, LANGUAGE_NOTE, type IngestOutcome } from './ingest-statement.js';
import { routineGate } from './scheduler.js';
import { scoped } from '../log.js';

const log = scoped('jobs.background-turns');

/**
 * Claude tick: statements that arrived through routine channels (Gmail) and have no plan yet get
 * their planning turn when the usage gate is open. One per tick; the pool gives background work a
 * single slot and yields to people.
 */
/**
 * Banks re-send the same statement (the mailbox holds two "July" mails). A parsed statement whose
 * institution, kind and period match an earlier one is marked `ignored` and its empty conversation
 * archived, so only one planning turn runs per period.
 */
export async function ignoreDuplicateStatements(ctx: AppContext): Promise<number> {
  const dup = await many<{ id: string; conversation_id: string | null }>(
    ctx.db,
    `UPDATE advisor_statements s
     SET status = 'ignored', error = 'duplicate of statement ' || d.id
     FROM advisor_statements d
     WHERE s.source = 'gmail' AND s.status = 'parsed' AND d.id <> s.id AND d.created_at < s.created_at
       AND d.status IN ('parsed', 'planned', 'applied')
       AND d.institution IS NOT DISTINCT FROM s.institution AND d.kind = s.kind
       AND d.period_start IS NOT DISTINCT FROM s.period_start AND d.period_end IS NOT DISTINCT FROM s.period_end
       AND s.period_start IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM advisor_plans p WHERE p.statement_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM advisor_messages m WHERE m.conversation_id = s.conversation_id)
     RETURNING s.id, s.conversation_id`,
  );
  for (const d of dup) {
    // The conversation is shared by the account's other statements; archive it only when nothing live is left.
    if (d.conversation_id) {
      await ctx.db.query(
        `UPDATE advisor_conversations SET status = 'archived'
         WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM advisor_statements x WHERE x.conversation_id = $1 AND x.status <> 'ignored')`,
        [d.conversation_id],
      );
    }
  }
  if (dup.length) log.info({ count: dup.length }, 'duplicate statements ignored');
  return dup.length;
}

export type WaitingStatement = Statement & { conversation_created_by: string | null };

/** Statements of one account keep arriving for a while (initial sync, re-sent mails); the background turn waits this long after the last one. */
export const SETTLE_SECONDS = 180;

/**
 * Gmail statements parsed but not planned yet. In the account's own conversation (`channel =
 * 'system'`, only the daemon writes there) a statement waits until it has a plan, with at most
 * `maxAttempts` turns opened after it arrived (a turn that ran out of time or asked a question does
 * not strand the period; a person can always press "Planejar agora"). In a person's conversation a
 * statement waits only while nobody wrote after it arrived. With `settleSeconds` a conversation whose
 * newest statement is younger than that is left out, so a burst of mails is planned together.
 */
export async function findWaitingStatements(ctx: AppContext, conversationId?: string, opts: { settleSeconds?: number; maxAttempts?: number } = {}): Promise<WaitingStatement[]> {
  return many<WaitingStatement>(
    ctx.db,
    `SELECT s.*, c.created_by AS conversation_created_by FROM advisor_statements s
     JOIN advisor_conversations c ON c.id = s.conversation_id
     WHERE s.source = 'gmail' AND s.status IN ('parsed','failed') AND s.conversation_id IS NOT NULL
       AND ($1::uuid IS NULL OR s.conversation_id = $1::uuid)
       AND NOT EXISTS (SELECT 1 FROM advisor_plans p WHERE p.statement_id = s.id)
       AND (
         (c.channel = 'system' AND (SELECT count(*) FROM advisor_messages m WHERE m.conversation_id = s.conversation_id AND m.role = 'user' AND m.created_at > s.created_at) < $3)
         OR (c.channel <> 'system' AND NOT EXISTS (SELECT 1 FROM advisor_messages m WHERE m.conversation_id = s.conversation_id AND m.role = 'user' AND m.created_at > s.created_at))
       )
       AND NOT EXISTS (SELECT 1 FROM advisor_statements n WHERE n.conversation_id = s.conversation_id AND n.created_at > now() - make_interval(secs => $2::float8))
     ORDER BY s.period_start ASC NULLS LAST, s.created_at ASC LIMIT 50`,
    [conversationId ?? null, opts.settleSeconds ?? 0, opts.maxAttempts ?? 1000],
  );
}

/** Automatic attempts per statement before a person has to ask (each attempt is a Claude turn). */
export const MAX_AUTO_ATTEMPTS = 2;

export interface PeriodGroup {
  key: string;
  /** The OFX when the period came in several formats, else the first file */
  primary: WaitingStatement;
  others: WaitingStatement[];
}

/** One group per statement period, oldest first; several formats of one period (OFX + CSV + PDF) share a group. */
export function groupByPeriod(statements: WaitingStatement[]): PeriodGroup[] {
  const groups = new Map<string, WaitingStatement[]>();
  for (const s of statements) {
    const key = s.period_start || s.period_end ? `${s.period_start ?? '?'}..${s.period_end ?? '?'}` : `file:${s.id}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const primary = list.find((s) => s.format === 'ofx') ?? list[0]!;
      return { key, primary, others: list.filter((s) => s !== primary) };
    })
    .sort((a, b) => (a.primary.period_start ?? '9999').localeCompare(b.primary.period_start ?? '9999') || a.primary.created_at.localeCompare(b.primary.created_at));
}

const outcomeOf = (s: WaitingStatement): IngestOutcome => {
  const lines = s.lines ?? [];
  return {
    statement_id: s.id,
    conversation_id: s.conversation_id!,
    status: s.status,
    duplicate: false,
    format: s.format,
    institution: s.institution,
    kind: s.kind,
    account_id: s.account_id,
    line_count: lines.length,
    already_in_ledger: lines.filter((l) => l.already_in_ledger).length,
    auto_matched: lines.filter((l) => l.auto_matched).length,
    likely_duplicate: lines.filter((l) => l.likely_duplicate && !l.already_in_ledger).length,
    period_start: s.period_start,
    period_end: s.period_end,
    closing_balance: s.closing_balance,
    error: s.error,
  };
};

/**
 * The text that opens a planning turn. One period: the usual statement message (other formats of the
 * same period are cross-check material). Several periods of one account: all of them listed oldest
 * first for context, with the instruction to plan the oldest now; the following periods get their own
 * turns in the same conversation (`startPlanningTurn` chains them), so one turn never has to walk
 * several statements before its timeout.
 */
export function buildPlanningMessage(statements: WaitingStatement[]): { text: string; primary: WaitingStatement } {
  const groups = groupByPeriod(statements);
  if (groups.length === 1) {
    const g = groups[0]!;
    const note = g.others.length > 0 ? `The same email carried ${g.others.length + 1} files (${[g.primary, ...g.others].map((s) => `${s.id} ${s.filename}`).join('; ')}); the OFX is primary, use the others to cross-check.` : null;
    return { text: buildIngestMessage(g.primary, outcomeOf(g.primary), note), primary: g.primary };
  }
  const first = groups[0]!.primary;
  const parts = [
    `${groups.length} statement periods of the same account arrived together (${first.institution ?? 'unknown institution'} / ${first.kind}).`,
    first.account_id
      ? `Ledger account: ${first.account_id}.`
      : 'The ledger account is not known yet: resolve it with match_account from the statement metadata and the user, and record it with note_add (scope account, note "statement_source=<institution>:<acctid>").',
    `All of them go into ONE plan. ${BATCH_STEPS}`,
    'Before anything else check continuity: the first period\'s opening balance must match the last balanced reconciliation (reconciliation_history), and each later period\'s opening must equal the closing before it; report breaks first.',
    '',
  ];
  for (const g of groups) {
    const o = outcomeOf(g.primary);
    const s = g.primary;
    if (o.status === 'failed') parts.push(`- Statement ${s.id} (${s.filename}): could not be parsed (${o.error}); the file is in the workspace.`);
    else parts.push(`- Statement ${s.id} (${s.filename}, ${o.format}): ${o.period_start ?? '?'} to ${o.period_end ?? '?'}, ${o.line_count} lines, ${o.already_in_ledger} already in the ledger by FITID, ${o.likely_duplicate} likely duplicates, opening balance ${s.opening_balance ?? 'unknown'}, closing balance ${o.closing_balance ?? 'unknown'}.`);
    if (g.others.length > 0) parts.push(`  Same period in other formats, cross-check only: ${g.others.map((x) => `${x.id} ${x.filename}`).join('; ')}.`);
  }
  parts.push('', LANGUAGE_NOTE);
  return { text: parts.join('\n'), primary: first };
}

/**
 * Starts the planning turn for one conversation's waiting statements: one turn, one plan for all
 * the periods (the system vouches what already matches; the assistant only decides the rest).
 */
export function startPlanningTurn(ctx: AppContext, conversationId: string, statements: WaitingStatement[], opts: { actor: string | null; kind: 'interactive' | 'background' }): Promise<unknown> {
  const { text, primary } = buildPlanningMessage(statements);
  log.info({ conversationId, statementId: primary.id, statements: statements.length, kind: opts.kind, actor: opts.actor }, 'starting planning turn');
  const names = statements.map((s) => s.filename);
  return ctx.sessions.sendUserMessage(conversationId, text, {
    actor: opts.actor,
    kind: opts.kind,
    attachments: statements.map((s) => ({ statement_id: s.id, filename: s.filename, format: s.format })),
    display: `📎 ${names.length > 3 ? `${names.length} extratos: ${names.slice(0, 3).join(', ')}…` : names.join(', ')} (Gmail)`,
    timeoutMs: ctx.config.PLANNING_TURN_TIMEOUT_MS,
  });
}

/** Groups waiting statements by conversation, oldest first. */
export function groupByConversation(waiting: WaitingStatement[]): Map<string, WaitingStatement[]> {
  const byConv = new Map<string, WaitingStatement[]>();
  for (const s of waiting) byConv.set(s.conversation_id!, [...(byConv.get(s.conversation_id!) ?? []), s]);
  return byConv;
}

/**
 * Claude tick: statements that arrived through routine channels (Gmail) and have no plan yet get
 * their planning turn when the usage gate is open. One per tick; the pool gives background work a
 * single slot and yields to people. A person can skip the wait with "Planejar agora" (interactive).
 */
export async function backgroundTurnsJob(ctx: AppContext): Promise<void> {
  await ignoreDuplicateStatements(ctx);
  const byConv = groupByConversation(await findWaitingStatements(ctx, undefined, { settleSeconds: SETTLE_SECONDS, maxAttempts: MAX_AUTO_ATTEMPTS }));
  if (byConv.size === 0) return;
  const [conversationId, statements] = [...byConv.entries()][0]!;
  const gate = await routineGate(ctx);
  if (!gate.open) {
    log.info({ reason: gate.reason, waiting: byConv.size }, 'gate closed; background turn deferred');
    return;
  }
  await startPlanningTurn(ctx, conversationId, statements, { actor: 'gmail', kind: 'background' });
}
