import type { Queryable } from '../client.js';
import { many, maybeOne, one } from '../client.js';
import type { ClaudeCall, Note } from '../types.js';

// ---- advisor_state -----------------------------------------------------------------------

export async function getState<T = unknown>(q: Queryable, key: string): Promise<T | null> {
  const row = await maybeOne<{ value: T }>(q, 'SELECT value FROM advisor_state WHERE key = $1', [key]);
  return row ? row.value : null;
}

export async function setState(q: Queryable, key: string, value: unknown): Promise<void> {
  await q.query(
    `INSERT INTO advisor_state (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

// ---- advisor_events (idempotency) --------------------------------------------------------

/** Returns true when the event is new (and now recorded), false when it was seen before. */
export async function claimEvent(
  q: Queryable,
  input: { source: 'discord' | 'gmail' | 'web' | 'scheduler'; external_id: string; kind: string; payload?: unknown },
): Promise<boolean> {
  const res = await q.query(
    `INSERT INTO advisor_events (source, external_id, kind, payload) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (source, external_id) DO NOTHING RETURNING id`,
    [input.source, input.external_id, input.kind, JSON.stringify(input.payload ?? {})],
  );
  return res.rowCount === 1;
}

export async function setEventOutcome(q: Queryable, source: string, externalId: string, outcome: string): Promise<void> {
  await q.query('UPDATE advisor_events SET outcome = $3 WHERE source = $1 AND external_id = $2', [source, externalId, outcome]);
}

// ---- advisor_notes -----------------------------------------------------------------------

export async function listNotes(q: Queryable, scope?: string, refId?: string | null): Promise<Note[]> {
  if (!scope) return many<Note>(q, 'SELECT * FROM advisor_notes ORDER BY created_at DESC LIMIT 200');
  if (refId) return many<Note>(q, 'SELECT * FROM advisor_notes WHERE scope = $1 AND ref_id = $2 ORDER BY created_at DESC', [scope, refId]);
  return many<Note>(q, 'SELECT * FROM advisor_notes WHERE scope = $1 ORDER BY created_at DESC LIMIT 200', [scope]);
}

export async function addNote(q: Queryable, input: { scope: Note['scope']; ref_id?: string | null; note: string; created_by?: string | null }): Promise<Note> {
  return one<Note>(q, 'INSERT INTO advisor_notes (scope, ref_id, note, created_by) VALUES ($1, $2, $3, $4) RETURNING *', [
    input.scope,
    input.ref_id ?? null,
    input.note,
    input.created_by ?? null,
  ]);
}

export async function findNoteByPrefix(q: Queryable, scope: Note['scope'], prefix: string): Promise<Note[]> {
  return many<Note>(q, 'SELECT * FROM advisor_notes WHERE scope = $1 AND note LIKE $2 ORDER BY created_at DESC', [scope, `${prefix}%`]);
}

// ---- advisor_claude_calls ----------------------------------------------------------------

export async function recordClaudeCall(
  q: Queryable,
  input: Omit<ClaudeCall, 'id' | 'started_at'> & { started_at: Date },
): Promise<ClaudeCall> {
  return one<ClaudeCall>(
    q,
    `INSERT INTO advisor_claude_calls (conversation_id, claude_session_id, mode, model, started_at, duration_ms, exit_code, usage, cost_usd, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) RETURNING *`,
    [
      input.conversation_id,
      input.claude_session_id,
      input.mode,
      input.model,
      input.started_at,
      input.duration_ms,
      input.exit_code,
      input.usage ? JSON.stringify(input.usage) : null,
      input.cost_usd,
      input.error,
    ],
  );
}

export async function countRecentCalls(q: Queryable, sinceMinutes: number): Promise<{ count: number; last_at: string | null }> {
  const row = await one<{ count: number; last_at: string | null }>(
    q,
    `SELECT count(*)::int AS count, max(started_at) AS last_at FROM advisor_claude_calls WHERE started_at > now() - ($1 || ' minutes')::interval`,
    [String(sinceMinutes)],
  );
  return row;
}

// ---- advisor_usage_snapshots -------------------------------------------------------------

export async function recordUsageSnapshot(
  q: Queryable,
  s: {
    five_hour_pct: number | null;
    five_hour_resets_at: string | null;
    seven_day_pct: number | null;
    seven_day_resets_at: string | null;
    locked: boolean;
    decision: string;
    reason: string;
  },
): Promise<void> {
  await q.query(
    `INSERT INTO advisor_usage_snapshots (five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, locked, decision, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [s.five_hour_pct, s.five_hour_resets_at, s.seven_day_pct, s.seven_day_resets_at, s.locked, s.decision, s.reason],
  );
}
