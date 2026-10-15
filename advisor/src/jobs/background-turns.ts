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
export async function backgroundTurnsJob(ctx: AppContext): Promise<void> {
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
