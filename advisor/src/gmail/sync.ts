import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { GmailClient, attachments, header, senderAddress } from './client.js';
import { claimEvent, getState, setEventOutcome, setState, recordClaudeCall } from '../db/repo/misc.js';
import { createConversation } from '../db/repo/conversations.js';
import { detectInstitution } from '../ingest/detect.js';
import { ingestBuffer } from '../jobs/ingest-statement.js';
import { routineGate } from '../jobs/scheduler.js';
import { runSingleShot } from '../claude/runner.js';
import { setChannelStatus } from '../http/routes/health.js';
import { scoped } from '../log.js';

const log = scoped('gmail');

const routeSchema = z.object({
  decision: z.enum(['statement', 'invoice', 'ignore']),
  institution: z.string().nullable(),
  kind: z.enum(['account', 'card', 'investment', 'other']),
  reason: z.string(),
});

const STATEMENT_EXT = /\.(ofx|csv|pdf|xlsx|xls)$/i;
const PREFERRED = ['.ofx', '.csv', '.pdf', '.xlsx', '.xls'];

export class GmailSync {
  private client: GmailClient;
  private labelId: string | null | undefined;

  constructor(private readonly ctx: AppContext) {
    const c = ctx.config;
    this.client = new GmailClient({ clientId: c.GMAIL_CLIENT_ID!, clientSecret: c.GMAIL_CLIENT_SECRET!, refreshToken: c.GMAIL_REFRESH_TOKEN! });
  }

  /** One cheap tick: walk history (or the 14-day initial query), route each new message. */
  async tick(): Promise<void> {
    const cursor = await getState<{ historyId: string; email?: string }>(this.ctx.db, 'gmail_cursor');
    let ids: string[] = [];
    let nextHistoryId: string;
    try {
      if (cursor?.historyId) {
        const r = await this.client.messagesSince(cursor.historyId);
        if (r) {
          ids = r.ids;
          nextHistoryId = r.historyId;
        } else {
          log.warn('history id expired; resyncing with a query');
          const prof = await this.client.profile();
          ids = await this.client.listMessageIds(`has:attachment newer_than:${this.ctx.config.GMAIL_LOOKBACK_DAYS}d`);
          nextHistoryId = prof.historyId;
        }
      } else {
        const prof = await this.client.profile();
        ids = await this.client.listMessageIds(`has:attachment newer_than:${this.ctx.config.GMAIL_LOOKBACK_DAYS}d`);
        nextHistoryId = prof.historyId;
        await setState(this.ctx.db, 'gmail_cursor', { historyId: nextHistoryId, email: prof.emailAddress, at: new Date().toISOString() });
      }
      setChannelStatus({ name: 'gmail', enabled: true, ok: true, detail: `cursor ${nextHistoryId}, ${ids.length} new` });
    } catch (err) {
      setChannelStatus({ name: 'gmail', enabled: true, ok: false, detail: (err as Error).message.slice(0, 200) });
      throw err;
    }

    for (const id of ids) {
      if (!(await claimEvent(this.ctx.db, { source: 'gmail', external_id: id, kind: 'message' }))) continue;
      try {
        const outcome = await this.handleMessage(id);
        await setEventOutcome(this.ctx.db, 'gmail', id, outcome);
      } catch (err) {
        log.error({ err, id }, 'gmail message failed');
        await setEventOutcome(this.ctx.db, 'gmail', id, `error: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    await setState(this.ctx.db, 'gmail_cursor', { ...(cursor ?? {}), historyId: nextHistoryId, at: new Date().toISOString() });
  }

  private async handleMessage(id: string): Promise<string> {
    const m = await this.client.getMessage(id);
    const from = senderAddress(header(m, 'From'));
    const subject = header(m, 'Subject') ?? '';
    const atts = attachments(m).filter((a) => STATEMENT_EXT.test(a.filename));
    if (atts.length === 0) return 'no statement attachments';

    let det = detectInstitution({ filename: atts[0]!.filename, sender: from, subject });
    let decision: 'statement' | 'invoice' | 'ignore' = det.institution ? 'statement' : 'ignore';
    if (!det.institution) {
      // Unknown sender with a statement-like attachment: ask Sonnet (routine → gated).
      const gate = await routineGate(this.ctx);
      if (!gate.open) {
        // Leave the event unclaimed-equivalent: record outcome and let a later tick retry by deleting the claim.
        await this.ctx.db.query('DELETE FROM advisor_events WHERE source = $1 AND external_id = $2', ['gmail', id]);
        return `deferred: gate closed (${gate.reason})`;
      }
      const routed = await this.route({ from, subject, filenames: atts.map((a) => a.filename), snippet: (m as { snippet?: string }).snippet ?? '' });
      decision = routed.decision;
      det = { institution: routed.institution, kind: routed.kind };
    }
    if (decision !== 'statement') return `ignored (${decision})`;

    // Prefer OFX, keep the others in the same conversation.
    const sorted = [...atts].sort((a, b) => PREFERRED.indexOf(path.extname(a.filename).toLowerCase()) - PREFERRED.indexOf(path.extname(b.filename).toLowerCase()));
    const title = `${det.institution ?? 'Extrato'} ${det.kind === 'card' ? 'cartão' : 'conta'} · ${subject.replace(/^.*?(\d{2}\/\d{2}\/\d{4}.*)$/, '$1').slice(0, 60)}`.trim();
    const conv = await createConversation(this.ctx.db, { channel: 'system', title, created_by: 'gmail' });
    let primary = true;
    const results: string[] = [];
    for (const a of sorted) {
      const buf = await this.client.getAttachment(id, a.attachmentId);
      const r = await ingestBuffer(this.ctx, {
        buffer: buf,
        filename: a.filename,
        source: 'gmail',
        conversationId: conv.id,
        actor: 'gmail',
        kind: 'background',
        gmailMessageId: id,
        sender: from,
        subject,
        startTurn: false, // background turns start from the gated job
      });
      results.push(`${a.filename}:${r.status}`);
      if (primary) {
        await setState(this.ctx.db, `gmail_primary:${conv.id}`, { statement_id: r.statement_id });
        primary = false;
      }
    }
    await this.label(id);
    this.ctx.bus.emitGlobal({ type: 'statement', statementId: conv.id, conversationId: conv.id, status: 'received' });
    return `ingested ${results.join(', ')}`;
  }

  private async label(messageId: string): Promise<void> {
    if (this.labelId === undefined) this.labelId = await this.client.ensureLabel('finances/processed');
    if (this.labelId) await this.client.addLabel(messageId, this.labelId);
  }

  private async route(input: { from: string | null; subject: string; filenames: string[]; snippet: string }): Promise<z.infer<typeof routeSchema>> {
    const system = await fs.readFile(path.join(this.ctx.promptsDir, 'route-mail.system.md'), 'utf8');
    const schema = JSON.parse(await fs.readFile(path.join(this.ctx.promptsDir, 'route-mail.schema.json'), 'utf8')) as Record<string, unknown>;
    const started = new Date();
    try {
      const r = await runSingleShot({ bin: this.ctx.config.CLAUDE_BIN, systemPrompt: system, jsonSchema: schema, input, model: this.ctx.config.ROUTINE_MODEL, timeoutMs: this.ctx.config.SINGLE_SHOT_TIMEOUT_MS });
      await recordClaudeCall(this.ctx.db, { conversation_id: null, claude_session_id: r.sessionId, mode: 'single', model: this.ctx.config.ROUTINE_MODEL, started_at: started, duration_ms: r.durationMs, exit_code: r.exitCode, usage: r.usage, cost_usd: r.costUsd, error: null });
      const parsed = routeSchema.safeParse(r.value);
      if (parsed.success) return parsed.data;
      log.warn({ issues: parsed.error.issues }, 'route-mail output invalid; ignoring message');
      return { decision: 'ignore', institution: null, kind: 'other', reason: 'invalid routing output' };
    } catch (err) {
      await recordClaudeCall(this.ctx.db, { conversation_id: null, claude_session_id: null, mode: 'single', model: this.ctx.config.ROUTINE_MODEL, started_at: started, duration_ms: Date.now() - started.getTime(), exit_code: null, usage: null, cost_usd: null, error: (err as Error).message });
      throw err;
    }
  }
}
