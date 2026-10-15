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

/** Candidate ledger transactions for one line, nearest date first. */
export interface AutoCandidate {
  hash: string;
  id: string;
  dd: number;
}

/**
 * Greedy one-to-one assignment: a line is vouched automatically only while it has exactly one
 * candidate transaction still free; a transaction vouches one line. Lines left with two or more
 * free candidates are ambiguous and stay for the assistant. Repeats until nothing changes, so a
 * transaction taken by an unambiguous line can disambiguate another.
 */
export function assignAutoMatches(cands: AutoCandidate[], taken: Set<string> = new Set()): Map<string, string> {
  const byLine = new Map<string, AutoCandidate[]>();
  for (const c of cands) byLine.set(c.hash, [...(byLine.get(c.hash) ?? []), c]);
  const out = new Map<string, string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [hash, list] of byLine) {
      if (out.has(hash)) continue;
      const free = [...new Set(list.filter((c) => !taken.has(c.id)).map((c) => c.id))];
      if (free.length === 1) {
        out.set(hash, free[0]!);
        taken.add(free[0]!);
        changed = true;
      }
    }
  }
  return out;
}

/**
 * Flags lines already in the ledger (FITID or a previous reconciliation), vouches lines
 * automatically (same amount, one free candidate on the account within 3 days), marks cent
 * differences on a hand-entered transaction (`amount_fix`), likely duplicates (±2 days, same
 * amount, similar description) for the rest, known aliases and the top category candidates.
 * One query per concern, not per line. `ledger_transaction_id` is set only for lines the system
 * vouches for; a likely duplicate keeps its candidate in `duplicate_candidate_id` for the assistant.
 */
export async function matchLines(db: Queryable, lines: StatementLine[], accountId: string | null): Promise<StatementLine[]> {
  if (lines.length === 0) return lines;
  const out: StatementLine[] = lines.map((l) => {
    const cp = extractCounterparty(l.raw);
    const copy: StatementLine = { ...l, already_in_ledger: false, likely_duplicate: false, auto_matched: false };
    delete copy.ledger_transaction_id;
    delete copy.duplicate_candidate_id;
    delete copy.amount_fix;
    if (cp) copy.counterparty = cp;
    else delete copy.counterparty;
    return copy;
  });
  const byHash = new Map(out.map((l) => [l.hash, l]));
  const rows: LineRow[] = out.map((l) => ({ hash: l.hash, date: l.date, amount: l.amount, raw: l.raw, fitid: l.fitid ?? null, hint: l.description_hint, posted_at: l.posted_at ?? null }));
  const json = JSON.stringify(rows);
  const taken = new Set<string>();

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
        taken.add(id);
      }
    }
  }

  // 1b. Lines a reconciliation already vouched for (statement_line_hash on a cleared item)
  const hashes = rows.map((r) => r.hash);
  const vouched = await db.query<{ hash: string; id: string }>(
    `SELECT ri.statement_line_hash AS hash, e.transaction_id AS id
     FROM reconciliation_items ri JOIN entries e ON e.id = ri.entry_id
     WHERE ri.kind = 'cleared' AND ri.statement_line_hash = ANY($1::text[])`,
    [hashes],
  );
  for (const v of vouched.rows) {
    const l = byHash.get(v.hash);
    if (l && !l.already_in_ledger) {
      l.already_in_ledger = true;
      l.ledger_transaction_id = v.id;
      taken.add(v.id);
    }
  }

  const pendingRows = () => rows.filter((r) => { const l = byHash.get(r.hash)!; return !l.already_in_ledger && !l.auto_matched && !l.amount_fix; });

  // 1c. Automatic vouching on the account: same amount, within 3 days, exactly one free candidate.
  if (accountId) {
    const pending = pendingRows();
    if (pending.length > 0) {
      const res = await db.query<{ hash: string; id: string; dd: number }>(
        `WITH l AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(hash text, date date, amount numeric))
         SELECT l.hash, t.id, abs(t.date - l.date) AS dd
         FROM l
         JOIN entries e ON e.account_id = $2::uuid AND abs(e.amount_base - l.amount) < 0.005
         JOIN transactions t ON t.id = e.transaction_id AND t.date BETWEEN l.date - 3 AND l.date + 3
         WHERE NOT EXISTS (
           SELECT 1 FROM reconciliation_items ri JOIN entries e2 ON e2.id = ri.entry_id
           WHERE ri.kind = 'cleared' AND e2.transaction_id = t.id AND e2.account_id = $2::uuid
         )
         ORDER BY l.hash, dd, t.created_at`,
        [JSON.stringify(pending.map((r) => ({ hash: r.hash, date: r.date, amount: r.amount }))), accountId],
      );
      const assigned = assignAutoMatches(res.rows.map((r) => ({ hash: r.hash, id: r.id, dd: Number(r.dd) })), taken);
      for (const [hash, id] of assigned) {
        const l = byHash.get(hash)!;
        l.auto_matched = true;
        l.ledger_transaction_id = id;
      }
    }
  }

  // 2. Likely duplicates for the rest (hint for the assistant; not vouched)
  {
    const pending = pendingRows();
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
        }
      }
    }
  }

  // 2b. Cent differences on the account: a hand-entered transaction within 3 days, similar name,
  //     amount off by up to R$ 1,00 and only two legs (so the correction is mechanical).
  if (accountId) {
    const pending = pendingRows().filter((r) => !byHash.get(r.hash)!.likely_duplicate);
    if (pending.length > 0) {
      const res = await db.query<{ hash: string; id: string; amount_base: number; description: string; legs: number }>(
        `WITH l AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(hash text, date date, amount numeric, raw text))
         SELECT l.hash, t.id, e.amount_base, t.description, (SELECT count(*) FROM entries e2 WHERE e2.transaction_id = t.id)::int AS legs
         FROM l
         JOIN entries e ON e.account_id = $2::uuid AND abs(e.amount_base - l.amount) BETWEEN 0.005 AND 1.00 AND sign(e.amount_base) = sign(l.amount)
         JOIN transactions t ON t.id = e.transaction_id AND t.date BETWEEN l.date - 3 AND l.date + 3
         WHERE similarity(normalize_text(t.description), normalize_merchant(l.raw)) > 0.3
            OR similarity(normalize_text(t.description), normalize_text(l.raw)) > 0.3
            OR normalize_text(t.description) = normalize_merchant(l.raw)
         ORDER BY l.hash, abs(e.amount_base - l.amount), abs(t.date - l.date), t.created_at DESC`,
        [JSON.stringify(pending), accountId],
      );
      for (const r of res.rows) {
        const l = byHash.get(r.hash)!;
        if (l.amount_fix || taken.has(r.id) || Number(r.legs) !== 2) continue;
        taken.add(r.id);
        l.amount_fix = { transaction_id: r.id, ledger_amount: Number(r.amount_base), description: r.description };
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

  // 4. Candidates for lines the system did not vouch for
  const toClassify = pendingRows();
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
