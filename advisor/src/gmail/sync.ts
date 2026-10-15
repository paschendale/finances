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
        log.info({ id, outcome }, 'gmail message handled');
        await setEventOutcome(this.ctx.db, 'gmail', id, outcome);
      } catch (err) {
        log.error({ err, id }, 'gmail message failed');
        await setEventOutcome(this.ctx.db, 'gmail', id, `error: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    await setState(this.ctx.db, 'gmail_cursor', { ...(cursor ?? {}), historyId: nextHistoryId, at: new Date().toISOString() });
  }

  /** Mails matching a Gmail query, with their attachment names (for "is the card statement there?"). */
  async search(query: string, limit = 20): Promise<Array<{ id: string; date: string | null; from: string | null; subject: string; attachments: string[]; institution: string | null; kind: string | null; claimed: boolean }>> {
    const ids = (await this.client.listMessageIds(query)).slice(0, limit);
    const out = [];
    for (const id of ids) {
      const m = await this.client.getMessage(id);
      const from = senderAddress(header(m, 'From'));
      const subject = header(m, 'Subject') ?? '';
      const atts = attachments(m).map((a) => a.filename);
      const stmt = atts.find((f) => STATEMENT_EXT.test(f));
      const det = stmt ? detectInstitution({ filename: stmt, sender: from, subject }) : null;
      const claimed = await this.ctx.db.query('SELECT 1 FROM advisor_events WHERE source = $1 AND external_id = $2', ['gmail', id]);
      out.push({ id, date: header(m, 'Date') ?? null, from, subject, attachments: atts, institution: det?.institution ?? null, kind: det?.kind ?? null, claimed: (claimed.rowCount ?? 0) > 0 });
    }
    return out;
  }

  /**
   * Picks up one mail on request (a person asked for it, so the planning turn starts right away as an
   * interactive turn instead of waiting for the gated background job). A mail already handled is
   * processed again only with `force`.
   */
  async ingestMessage(id: string, opts: { actor: string; force?: boolean }): Promise<{ outcome: string; conversation_id: string | null }> {
    const claimed = await claimEvent(this.ctx.db, { source: 'gmail', external_id: id, kind: 'message', payload: { manual: opts.actor } });
    if (!claimed && !opts.force) {
      const prev = await this.ctx.db.query<{ payload: unknown }>('SELECT payload FROM advisor_events WHERE source = $1 AND external_id = $2', ['gmail', id]);
      return { outcome: `already handled: ${JSON.stringify(prev.rows[0]?.payload ?? {})}`, conversation_id: null };
    }
    const r = await this.handleMessage(id, { interactive: true, actor: opts.actor });
    await setEventOutcome(this.ctx.db, 'gmail', id, r.outcome);
    return r;
  }

  private async handleMessage(id: string): Promise<string>;
  private async handleMessage(id: string, turn: { interactive: true; actor: string }): Promise<{ outcome: string; conversation_id: string | null }>;
  private async handleMessage(id: string, turn?: { interactive: true; actor: string }): Promise<string | { outcome: string; conversation_id: string | null }> {
    const r = await this.processMessage(id, turn);
    return turn ? r : r.outcome;
  }

  private async processMessage(id: string, turn?: { interactive: true; actor: string }): Promise<{ outcome: string; conversation_id: string | null }> {
    const done = (outcome: string, conversation_id: string | null = null) => ({ outcome, conversation_id });
    const m = await this.client.getMessage(id);
    const from = senderAddress(header(m, 'From'));
    const subject = header(m, 'Subject') ?? '';
    const atts = attachments(m).filter((a) => STATEMENT_EXT.test(a.filename));
    if (atts.length === 0) return done('no statement attachments');

    let det = detectInstitution({ filename: atts[0]!.filename, sender: from, subject });
    let decision: 'statement' | 'invoice' | 'ignore' = det.institution ? 'statement' : 'ignore';
    if (!det.institution) {
      // Unknown sender with a statement-like attachment: ask Sonnet (routine → gated).
      const gate = await routineGate(this.ctx);
      if (!gate.open && !turn) {
        // Leave the event unclaimed-equivalent: record outcome and let a later tick retry by deleting the claim.
        await this.ctx.db.query('DELETE FROM advisor_events WHERE source = $1 AND external_id = $2', ['gmail', id]);
        return done(`deferred: gate closed (${gate.reason})`);
      }
      const routed = await this.route({ from, subject, filenames: atts.map((a) => a.filename), snippet: (m as { snippet?: string }).snippet ?? '' });
      decision = routed.decision;
      det = { institution: routed.institution, kind: routed.kind };
    }
    if (decision !== 'statement') return done(`ignored (${decision})`);

    // Prefer OFX; the other formats of the same statement (banks attach OFX + CSV + PDF of one
    // period) are only ingested when the preferred one yields no lines.
    const sorted = [...atts].sort((a, b) => PREFERRED.indexOf(path.extname(a.filename).toLowerCase()) - PREFERRED.indexOf(path.extname(b.filename).toLowerCase()));
    const title = `${det.institution ?? 'Extrato'} ${det.kind === 'card' ? 'cartão' : 'conta'} · ${subject.replace(/^.*?(\d{2}\/\d{2}\/\d{4}.*)$/, '$1').slice(0, 60)}`.trim();
    const conv = await createConversation(this.ctx.db, { channel: 'system', title, created_by: turn ? turn.actor : 'gmail' });
    const results: string[] = [];
    let primaryLines = 0;
    for (const [i, a] of sorted.entries()) {
      if (i > 0 && primaryLines > 0) {
        results.push(`${a.filename}:skipped (same statement as ${sorted[0]!.filename})`);
        continue;
      }
      const buf = await this.client.getAttachment(id, a.attachmentId);
      const r = await ingestBuffer(this.ctx, {
        buffer: buf,
        filename: a.filename,
        source: 'gmail',
        conversationId: conv.id,
        actor: turn ? turn.actor : 'gmail',
        kind: turn ? 'interactive' : 'background',
        gmailMessageId: id,
        sender: from,
        subject,
        message: turn ? `Statement picked up from Gmail on request (${subject}).` : null,
        startTurn: Boolean(turn) && i === 0, // background turns start from the gated job; a manual pick-up plans right away
      });
      results.push(`${a.filename}:${r.status}:${r.line_count}`);
      if (i === 0) {
        primaryLines = r.line_count;
        await setState(this.ctx.db, `gmail_primary:${conv.id}`, { statement_id: r.statement_id });
      }
    }
    await this.label(id);
    this.ctx.bus.emitGlobal({ type: 'statement', statementId: conv.id, conversationId: conv.id, status: 'received' });
    return done(`ingested ${results.join(', ')}`, conv.id);
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
