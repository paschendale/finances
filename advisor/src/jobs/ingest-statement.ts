import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppContext } from '../context.js';
import type { Statement, StatementKind } from '../db/types.js';
import { createStatement, findStatementBySha, updateStatement } from '../db/repo/statements.js';
import { findNoteByPrefix } from '../db/repo/misc.js';
import { many, maybeOne } from '../db/client.js';
import { detectFormat, detectInstitution, parseStatementFile } from '../ingest/detect.js';
import { matchLines } from '../ingest/match.js';
import { toCsv } from '../ingest/normalize.js';
import { scoped } from '../log.js';

const log = scoped('ingest');

export class IngestError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

export interface IngestInput {
  buffer: Buffer;
  filename: string;
  source: 'upload' | 'gmail';
  conversationId: string;
  actor: string | null;
  message?: string | null;
  kind: 'interactive' | 'background';
  gmailMessageId?: string | null;
  sender?: string | null;
  subject?: string | null;
  /** When false, store and parse but do not start a Claude turn (the caller will). */
  startTurn?: boolean;
}

export interface IngestOutcome {
  statement_id: string;
  status: string;
  duplicate: boolean;
  format: string;
  institution: string | null;
  kind: StatementKind;
  account_id: string | null;
  line_count: number;
  already_in_ledger: number;
  likely_duplicate: number;
  period_start: string | null;
  period_end: string | null;
  closing_balance: number | null;
  error: string | null;
}

export function statementsStorageDir(dataDir: string): string {
  return path.join(dataDir, 'statements');
}

/**
 * Resolve which ledger account a statement belongs to: notes `statement_source=<institution>:<acctid>`
 * (scope account) first; then a single visible checking account for the institution by name match.
 */
export async function resolveStatementAccount(ctx: AppContext, institution: string | null, kind: StatementKind, accountRef: string | null): Promise<string | null> {
  if (institution && accountRef) {
    const notes = await findNoteByPrefix(ctx.db, 'account', `statement_source=${institution}:${accountRef}`);
    const withRef = notes.find((n) => n.ref_id);
    if (withRef) return withRef.ref_id;
  }
  if (institution) {
    const notes = await findNoteByPrefix(ctx.db, 'account', `statement_source=${institution}:*`);
    const generic = notes.find((n) => n.ref_id && n.note.includes(`kind=${kind}`));
    if (generic) return generic.ref_id;
    // Heuristic: one visible asset/liability account whose name mentions the institution and matches the kind.
    const type = kind === 'card' ? 'liability' : 'asset';
    const rows = await many<{ id: string }>(
      ctx.db,
      `SELECT h.id FROM account_names_hierarchical h JOIN accounts a ON a.id = h.id
       WHERE a.hidden = false AND a.type = $1 AND (lower(h.full_name) LIKE '%' || $2 || '%' OR lower(h.full_name) LIKE '%' || $3 || '%')`,
      [type, institution.toLowerCase(), institution.toLowerCase().slice(0, 2)],
    );
    if (rows.length === 1) return rows[0]!.id;
  }
  return null;
}

export async function ingestBuffer(ctx: AppContext, input: IngestInput): Promise<IngestOutcome> {
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const existing = await findStatementBySha(ctx.db, sha256);
  const format = detectFormat(input.filename, input.buffer);
  if (format === 'other') throw new IngestError(`unsupported file type for ${input.filename}`, 415);

  const dir = statementsStorageDir(ctx.config.DATA_DIR);
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(input.filename).toLowerCase() || `.${format}`;
  const storagePath = path.join(dir, `${sha256}${ext}`);
  await fs.writeFile(storagePath, input.buffer);

  let statement: Statement;
  let duplicate = false;
  if (existing) {
    duplicate = true;
    statement = existing;
    log.info({ statementId: existing.id, filename: input.filename }, 'statement already known; re-attaching to conversation');
    if (existing.conversation_id !== input.conversationId) {
      statement = await updateStatement(ctx.db, existing.id, { conversation_id: input.conversationId });
    }
  } else {
    const det = detectInstitution({ filename: input.filename, sender: input.sender ?? null, subject: input.subject ?? null });
    statement = await createStatement(ctx.db, {
      source: input.source,
      filename: input.filename,
      sha256,
      format,
      kind: det.kind,
      institution: det.institution,
      storage_path: storagePath,
      gmail_message_id: input.gmailMessageId ?? null,
      conversation_id: input.conversationId,
    });
  }

  // Parse (or re-parse on duplicate so the flags reflect the ledger now).
  let linesCsv: string | null = null;
  try {
    const { parsed, error } = await parseStatementFile(storagePath, input.filename, { sender: input.sender ?? null, subject: input.subject ?? null });
    if (parsed) {
      const institution = parsed.institution ?? statement.institution;
      const kind = (parsed.kind !== 'other' ? parsed.kind : statement.kind) as StatementKind;
      const accountId = statement.account_id ?? (await resolveStatementAccount(ctx, institution, kind, parsed.account_ref));
      const lines = await matchLines(ctx.db, parsed.lines, accountId);
      statement = await updateStatement(ctx.db, statement.id, {
        institution,
        kind,
        account_id: accountId,
        period_start: parsed.period_start,
        period_end: parsed.period_end,
        currency: parsed.currency,
        opening_balance: parsed.opening_balance,
        closing_balance: parsed.closing_balance,
        lines,
        status: statement.status === 'applied' ? 'applied' : 'parsed',
        error: parsed.warnings.length ? parsed.warnings.join('; ') : null,
      });
      linesCsv = toCsv(lines);
      if (parsed.account_ref && institution) {
        await rememberAccountRef(ctx, institution, parsed.account_ref, accountId);
      }
    } else if (error) {
      statement = await updateStatement(ctx.db, statement.id, { status: 'failed', error });
    } else {
      // image / xlsx / unknown: Claude reads the file itself
      statement = await updateStatement(ctx.db, statement.id, { status: statement.status === 'received' ? 'parsed' : statement.status, lines: statement.lines ?? [] });
    }
  } catch (err) {
    log.warn({ err, statementId: statement.id }, 'statement parse failed');
    statement = await updateStatement(ctx.db, statement.id, { status: 'failed', error: (err as Error).message });
  }

  await ctx.sessions.attachStatement(input.conversationId, statement, storagePath, linesCsv);
  ctx.bus.emitGlobal({ type: 'statement', statementId: statement.id, conversationId: input.conversationId, status: statement.status });

  const lines = statement.lines ?? [];
  const outcome: IngestOutcome = {
    statement_id: statement.id,
    status: statement.status,
    duplicate,
    format,
    institution: statement.institution,
    kind: statement.kind,
    account_id: statement.account_id,
    line_count: lines.length,
    already_in_ledger: lines.filter((l) => l.already_in_ledger).length,
    likely_duplicate: lines.filter((l) => l.likely_duplicate && !l.already_in_ledger).length,
    period_start: statement.period_start,
    period_end: statement.period_end,
    closing_balance: statement.closing_balance,
    error: statement.error,
  };

  if (input.startTurn !== false) {
    const text = buildIngestMessage(statement, outcome, input.message ?? null);
    void ctx.sessions.sendUserMessage(input.conversationId, text, {
      actor: input.actor,
      kind: input.kind,
      attachments: [{ statement_id: statement.id, filename: statement.filename, format, size: input.buffer.length }],
      display: input.message?.trim() ? `${input.message.trim()}\n\n📎 ${statement.filename}` : `📎 ${statement.filename}`,
    });
  }
  return outcome;
}

async function rememberAccountRef(ctx: AppContext, institution: string, accountRef: string, accountId: string | null): Promise<void> {
  if (!accountId) return;
  const key = `statement_source=${institution}:${accountRef}`;
  const exists = await maybeOne(ctx.db, 'SELECT id FROM advisor_notes WHERE scope = $1 AND ref_id = $2 AND note LIKE $3', ['account', accountId, `${key}%`]);
  if (!exists) await ctx.db.query('INSERT INTO advisor_notes (scope, ref_id, note, created_by) VALUES ($1, $2, $3, $4)', ['account', accountId, key, 'advisor']);
}

export function buildIngestMessage(statement: Statement, o: IngestOutcome, userMessage: string | null): string {
  const parts: string[] = [];
  if (userMessage?.trim()) parts.push(userMessage.trim(), '');
  if (o.status === 'failed') {
    parts.push(`Statement ${statement.id} (${statement.filename}) was received but could not be parsed: ${o.error}. The original file is in the workspace; read it and tell the user what you can do with it.`);
    return parts.join('\n');
  }
  if (o.line_count === 0) {
    parts.push(`File ${statement.id} (${statement.filename}, ${o.format}) was received. It has no machine-readable lines; open it from the workspace with Read and extract the transactions yourself before building a plan.`);
    return parts.join('\n');
  }
  parts.push(
    `Statement ${statement.id} received (${o.institution ?? 'unknown institution'} / ${o.kind}, ${o.format}, ${statement.filename}).`,
    `Period ${o.period_start ?? '?'} to ${o.period_end ?? '?'}, ${o.line_count} lines, ${o.already_in_ledger} already in the ledger by FITID, ${o.likely_duplicate} likely duplicates, closing balance ${o.closing_balance ?? 'unknown'}.`,
    o.account_id ? `Ledger account: ${o.account_id}.` : 'The ledger account is not known yet: resolve it with match_account from the statement metadata and the user, and record it with note_add (scope account, note "statement_source=<institution>:<acctid>").',
    o.duplicate ? 'This exact file was ingested before; flags were recomputed against the ledger as it is now.' : '',
    'Build the insertion plan: read statement_lines, categorise with classify_candidates, pair transfers and card payments, draft with plan_create/plan_set_items, run the balance check, then plan_finalize. Report continuity breaks before anything else.',
  );
  return parts.filter((p) => p !== '').join('\n');
}
