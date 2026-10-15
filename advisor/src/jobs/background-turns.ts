import type { AppContext } from '../context.js';
import { many } from '../db/client.js';
import type { Statement } from '../db/types.js';
import { buildIngestMessage } from './ingest-statement.js';
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
    if (d.conversation_id) await ctx.db.query(`UPDATE advisor_conversations SET status = 'archived' WHERE id = $1`, [d.conversation_id]);
  }
  if (dup.length) log.info({ count: dup.length }, 'duplicate statements ignored');
  return dup.length;
}

export async function backgroundTurnsJob(ctx: AppContext): Promise<void> {
  await ignoreDuplicateStatements(ctx);
  const waiting = await many<Statement & { conversation_created_by: string | null }>(
    ctx.db,
    `SELECT s.*, c.created_by AS conversation_created_by FROM advisor_statements s
     JOIN advisor_conversations c ON c.id = s.conversation_id
     WHERE s.source = 'gmail' AND s.status IN ('parsed','failed') AND s.conversation_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM advisor_plans p WHERE p.statement_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM advisor_messages m WHERE m.conversation_id = s.conversation_id AND m.role = 'user')
     ORDER BY s.created_at ASC LIMIT 5`,
  );
  if (waiting.length === 0) return;
  // One turn per conversation: group statements of the same conversation into one message.
  const byConv = new Map<string, typeof waiting>();
  for (const s of waiting) byConv.set(s.conversation_id!, [...(byConv.get(s.conversation_id!) ?? []), s]);
  const [conversationId, statements] = [...byConv.entries()][0]!;

  const gate = await routineGate(ctx);
  if (!gate.open) {
    log.info({ reason: gate.reason, waiting: byConv.size }, 'gate closed; background turn deferred');
    return;
  }
  const primary = statements.find((s) => s.format === 'ofx') ?? statements[0]!;
  const lines = primary.lines ?? [];
  const text = buildIngestMessage(
    primary,
    {
      statement_id: primary.id,
      status: primary.status,
      duplicate: false,
      format: primary.format,
      institution: primary.institution,
      kind: primary.kind,
      account_id: primary.account_id,
      line_count: lines.length,
      already_in_ledger: lines.filter((l) => l.already_in_ledger).length,
      likely_duplicate: lines.filter((l) => l.likely_duplicate && !l.already_in_ledger).length,
      period_start: primary.period_start,
      period_end: primary.period_end,
      closing_balance: primary.closing_balance,
      error: primary.error,
    },
    statements.length > 1 ? `The same email carried ${statements.length} files (${statements.map((s) => `${s.id} ${s.filename}`).join('; ')}); the OFX is primary, use the others to cross-check.` : null,
  );
  log.info({ conversationId, statementId: primary.id, reason: gate.reason }, 'starting background planning turn');
  await ctx.sessions.sendUserMessage(conversationId, text, {
    actor: 'gmail',
    kind: 'background',
    attachments: statements.map((s) => ({ statement_id: s.id, filename: s.filename, format: s.format })),
    display: `📎 ${statements.map((s) => s.filename).join(', ')} (Gmail)`,
  });
}
