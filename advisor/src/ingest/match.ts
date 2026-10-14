import type { Queryable } from '../db/client.js';
import type { StatementLine, StatementLineCandidate } from '../db/types.js';

const PIX_COUNTERPARTY = /transfer[eê]ncia (?:enviada|recebida) pelo pix\s*-\s*([^-]+?)\s*-\s*/i;

export function extractCounterparty(raw: string): string | null {
  const m = raw.match(PIX_COUNTERPARTY);
  return m ? m[1]!.trim() : null;
}

export function isCardPayment(raw: string): boolean {
  const s = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  return /pagamento (de|da) fatura|pagamento recebido/.test(s);
}

/** Pairs lines across two statements: same |amount|, opposite sign, ±1 day. Returns hash pairs. */
export function pairTransfers(a: StatementLine[], b: StatementLine[]): Array<{ a: string; b: string }> {
  const used = new Set<string>();
  const out: Array<{ a: string; b: string }> = [];
  const dayDiff = (x: string, y: string) => Math.abs((Date.parse(`${x}T00:00:00Z`) - Date.parse(`${y}T00:00:00Z`)) / 86_400_000);
  for (const la of a) {
    const match = b.find((lb) => !used.has(lb.hash) && Math.abs(Math.abs(lb.amount) - Math.abs(la.amount)) < 0.005 && Math.sign(lb.amount) === -Math.sign(la.amount) && dayDiff(la.date, lb.date) <= 1);
    if (match) {
      used.add(match.hash);
      out.push({ a: la.hash, b: match.hash });
    }
  }
  return out;
}

interface LineRow {
  hash: string;
  date: string;
  amount: number;
  raw: string;
  fitid: string | null;
  hint: string;
  posted_at: string | null;
}

/**
 * Flags lines already in the ledger (FITID), likely duplicates (±2 days, same amount, similar
 * description), known aliases and the top category candidates. One query per concern, not per line.
 */
export async function matchLines(db: Queryable, lines: StatementLine[], accountId: string | null): Promise<StatementLine[]> {
  if (lines.length === 0) return lines;
  const out: StatementLine[] = lines.map((l) => {
    const cp = extractCounterparty(l.raw);
    const copy: StatementLine = { ...l, already_in_ledger: false, likely_duplicate: false };
    if (cp) copy.counterparty = cp;
    else delete copy.counterparty;
    return copy;
  });
  const byHash = new Map(out.map((l) => [l.hash, l]));
  const rows: LineRow[] = out.map((l) => ({ hash: l.hash, date: l.date, amount: l.amount, raw: l.raw, fitid: l.fitid ?? null, hint: l.description_hint, posted_at: l.posted_at ?? null }));
  const json = JSON.stringify(rows);

  // 1. FITID exact matches
  const fitids = rows.map((r) => r.fitid).filter((f): f is string => Boolean(f));
  if (fitids.length > 0) {
    const res = await db.query<{ id: string; fitid: string }>(`SELECT id, metadata->>'fitid' AS fitid FROM transactions WHERE metadata->>'fitid' = ANY($1::text[])`, [fitids]);
    const byFit = new Map(res.rows.map((r) => [r.fitid, r.id]));
    for (const l of out) {
      const id = l.fitid ? byFit.get(l.fitid) : undefined;
      if (id) {
        l.already_in_ledger = true;
        l.ledger_transaction_id = id;
      }
    }
  }

  // 2. Likely duplicates for the rest
  const pending = rows.filter((r) => !byHash.get(r.hash)!.already_in_ledger);
  if (pending.length > 0) {
    const res = await db.query<{ hash: string; id: string }>(
      `WITH l AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(hash text, date date, amount numeric, raw text)
       )
       SELECT DISTINCT ON (l.hash) l.hash, t.id
       FROM l
       JOIN entries e ON abs(e.amount_base - l.amount) < 0.005
       JOIN transactions t ON t.id = e.transaction_id AND t.date BETWEEN l.date - 2 AND l.date + 2
       JOIN accounts a ON a.id = e.account_id
       WHERE ($2::uuid IS NULL AND a.type IN ('asset','liability') OR e.account_id = $2::uuid)
         AND (similarity(normalize_text(t.description), normalize_text(l.raw)) > 0.4
              OR similarity(normalize_text(t.description), normalize_merchant(l.raw)) > 0.4
              OR normalize_text(t.description) = normalize_merchant(l.raw))
       ORDER BY l.hash, abs(t.date - l.date), t.created_at DESC`,
      [JSON.stringify(pending), accountId],
    );
    for (const r of res.rows) {
      const l = byHash.get(r.hash);
      if (l) {
        l.likely_duplicate = true;
        l.duplicate_candidate_id = r.id;
        l.ledger_transaction_id = r.id;
      }
    }
  }

  // 3. Aliases
  {
    const res = await db.query<{ hash: string; canonical_description: string; account_id: string | null }>(
      `WITH l AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(hash text, raw text))
       SELECT l.hash, ma.canonical_description, ma.account_id
       FROM l JOIN merchant_aliases ma ON ma.raw_normalized = normalize_merchant(l.raw)`,
      [json],
    );
    for (const r of res.rows) {
      const l = byHash.get(r.hash);
      if (l) l.alias = { canonical_description: r.canonical_description, account_id: r.account_id };
    }
  }

  // 4. Candidates for lines not already in the ledger
  const toClassify = rows.filter((r) => !byHash.get(r.hash)!.already_in_ledger);
  if (toClassify.length > 0) {
    const res = await db.query<{ hash: string; category_id: string; category_name: string; score: number; confidence: number }>(
      `WITH l AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(hash text, date date, amount numeric, raw text, hint text, posted_at timestamptz)
       )
       SELECT l.hash, c.category_id, c.category_name, c.score, c.confidence
       FROM l
       CROSS JOIN LATERAL classify_candidates(COALESCE(NULLIF(l.hint, ''), l.raw), l.amount, $2::uuid, l.date, l.posted_at, l.raw, 3) c
       ORDER BY l.hash, c.score DESC`,
      [JSON.stringify(toClassify), accountId],
    );
    const grouped = new Map<string, StatementLineCandidate[]>();
    for (const r of res.rows) {
      const arr = grouped.get(r.hash) ?? [];
      arr.push({ category_id: r.category_id, category_name: r.category_name, score: Number(r.score), confidence: Number(r.confidence) });
      grouped.set(r.hash, arr);
    }
    for (const l of out) {
      const c = grouped.get(l.hash);
      if (c && c.length > 0) l.candidates = c;
    }
  }

  return out;
}
