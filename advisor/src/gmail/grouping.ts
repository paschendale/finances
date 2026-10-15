import type { Queryable } from '../db/client.js';
import { many } from '../db/client.js';
import type { Statement, StatementKind } from '../db/types.js';

/**
 * Mailed statements are grouped per account: every statement of one account that is still waiting
 * for its planning turn joins the same conversation, so the advisor sees all periods together.
 * The key is the ledger account when it is known, else the institution and kind.
 */
export function accountConversationKey(s: Pick<Statement, 'account_id' | 'institution' | 'kind'>): string {
  return `gmail:${s.account_id ?? `${s.institution ?? 'desconhecido'}:${s.kind}`}`;
}

export function institutionLabel(institution: string | null): string {
  if (!institution) return 'Extrato';
  return institution.charAt(0).toUpperCase() + institution.slice(1);
}

export function kindLabel(kind: StatementKind): string {
  return kind === 'card' ? 'cartão' : kind === 'investment' ? 'investimentos' : 'conta';
}

const fmt = (iso: string | null): string => {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '?';
};

/** "Nubank conta · 01/07/2026 a 30/09/2026" over the periods of the statements in the conversation. */
export function accountConversationTitle(
  s: Pick<Statement, 'institution' | 'kind'>,
  periods: Array<Pick<Statement, 'period_start' | 'period_end'>>,
): string {
  const base = `${institutionLabel(s.institution)} ${kindLabel(s.kind)}`;
  const starts = periods.map((p) => p.period_start).filter((d): d is string => Boolean(d)).sort();
  const ends = periods.map((p) => p.period_end).filter((d): d is string => Boolean(d)).sort();
  if (starts.length === 0 && ends.length === 0) return base;
  return `${base} · ${fmt(starts[0] ?? null)} a ${fmt(ends[ends.length - 1] ?? null)}`;
}

/** Recomputes the conversation title from its live statements; returns the new title when it changed. */
export async function refreshAccountConversationTitle(q: Queryable, conversationId: string): Promise<string | null> {
  const stmts = await many<Pick<Statement, 'institution' | 'kind' | 'period_start' | 'period_end'>>(
    q,
    `SELECT institution, kind, period_start, period_end FROM advisor_statements
     WHERE conversation_id = $1 AND status <> 'ignored' ORDER BY created_at`,
    [conversationId],
  );
  if (stmts.length === 0) return null;
  const title = accountConversationTitle(stmts[0]!, stmts);
  const r = await q.query('UPDATE advisor_conversations SET title = $2 WHERE id = $1 AND title IS DISTINCT FROM $2', [conversationId, title]);
  return (r.rowCount ?? 0) > 0 ? title : null;
}
