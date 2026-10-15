import type { Queryable } from '../client.js';
import { many, maybeOne, one } from '../client.js';
import type { Statement, StatementFormat, StatementKind, StatementLine, StatementSource, StatementStatus } from '../types.js';

export async function findStatementBySha(q: Queryable, sha256: string): Promise<Statement | null> {
  return maybeOne<Statement>(q, 'SELECT * FROM advisor_statements WHERE sha256 = $1', [sha256]);
}

export async function getStatement(q: Queryable, id: string): Promise<Statement | null> {
  return maybeOne<Statement>(q, 'SELECT * FROM advisor_statements WHERE id = $1', [id]);
}

export async function createStatement(
  q: Queryable,
  input: {
    source: StatementSource;
    filename: string;
    sha256: string;
    format: StatementFormat;
    kind?: StatementKind;
    institution?: string | null;
    storage_path?: string | null;
    gmail_message_id?: string | null;
    conversation_id?: string | null;
  },
): Promise<Statement> {
  return one<Statement>(
    q,
    `INSERT INTO advisor_statements (source, filename, sha256, format, kind, institution, storage_path, gmail_message_id, conversation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      input.source,
      input.filename,
      input.sha256,
      input.format,
      input.kind ?? 'other',
      input.institution ?? null,
      input.storage_path ?? null,
      input.gmail_message_id ?? null,
      input.conversation_id ?? null,
    ],
  );
}

export async function updateStatement(
  q: Queryable,
  id: string,
  patch: Partial<{
    account_id: string | null;
    institution: string | null;
    kind: StatementKind;
    period_start: string | null;
    period_end: string | null;
    currency: string | null;
    opening_balance: number | null;
    closing_balance: number | null;
    lines: StatementLine[] | null;
    status: StatementStatus;
    error: string | null;
    conversation_id: string | null;
  }>,
): Promise<Statement> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    vals.push(k === 'lines' ? JSON.stringify(v) : v);
    sets.push(`${k} = $${vals.length}${k === 'lines' ? '::jsonb' : ''}`);
  }
  if (sets.length === 0) return one<Statement>(q, 'SELECT * FROM advisor_statements WHERE id = $1', [id]);
  vals.push(id);
  return one<Statement>(q, `UPDATE advisor_statements SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
}

export async function listStatements(q: Queryable, opts: { status?: StatementStatus[]; conversation_id?: string; limit?: number } = {}): Promise<Statement[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (opts.status?.length) {
    vals.push(opts.status);
    where.push(`status = ANY($${vals.length}::text[])`);
  }
  if (opts.conversation_id) {
    vals.push(opts.conversation_id);
    where.push(`conversation_id = $${vals.length}`);
  }
  vals.push(opts.limit ?? 100);
  return many<Statement>(
    q,
    `SELECT * FROM advisor_statements ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${vals.length}`,
    vals,
  );
}
