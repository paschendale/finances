/**
 * SQL-level tests for migrations 0050/0051 against a throwaway database (TEST_DATABASE_URL with all
 * migrations applied). Everything runs inside one transaction that is rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { isBalanced, recloseDecision, recomputeReconciliations, restoreClearings, snapshotClearings } from '../src/plan/clearings.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('migrations 0050 + 0051', () => {
  let client: pg.PoolClient;
  let pool: pg.Pool;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 1 });
    client = await pool.connect();
    await client.query('BEGIN');
    const tag = Math.random().toString(36).slice(2, 8);
    const mk = async (name: string, type: string, subtype: string) =>
      (await client.query('INSERT INTO accounts (name, type, subtype) VALUES ($1,$2,$3) RETURNING id', [`${name}-${tag}`, type, subtype])).rows[0].id as string;
    ids.nu = await mk('t-nu-conta', 'asset', 'checking');
    ids.food = await mk('t-alimentacao', 'expense', 'category');
    ids.out = await mk('t-fora', 'expense', 'category');
    ids.transp = await mk('t-transporte', 'expense', 'category');
    ids.tag = tag;
    const create = (date: string, desc: string, cat: string, amt: number, meta: unknown = {}) =>
      client.query('SELECT create_transaction($1::date, $2, $3::jsonb, $4::jsonb) AS t', [
        date,
        desc,
        JSON.stringify([
          { account_id: cat, amount: amt, currency: 'BRL', amount_base: amt },
          { account_id: ids.nu, amount: -amt, currency: 'BRL', amount_base: -amt },
        ]),
        JSON.stringify(meta),
      ]);
    for (let i = 1; i <= 10; i++) {
      await create(dateMinus(i * 7), `Qwerpo ${tag}`, ids.food, 45.9, {
        source: 'advisor',
        fitid: `fit-${tag}-${i}`,
        statement_line: { raw: `QWERPO ALIMENTOS LTDA ${tag}`, posted_at: `${dateMinus(i * 7)}T12:30:00-03:00`, fitid: `fit-${tag}-${i}` },
      });
    }
    await create(dateMinus(3), `Qwerpo Alimentos ${tag}`, ids.out, 120);
    for (let i = 1; i <= 3; i++) await create(dateMinus(i * 9), `Uber ${tag}`, ids.transp, 22.5);
  });

  afterAll(async () => {
    await client?.query('ROLLBACK');
    client?.release();
    await pool?.end();
  });

  it('normalize_merchant fixtures', async () => {
    const cases: Array<[string, string]> = [
      ['TAMPOPO ALIMENTOS LTDA', 'tampopo alimentos'],
      ['PG *TAMPOPO ALIMENTOS', 'tampopo alimentos'],
      ['Compra no débito - NETFLIX.COM 3/6', 'netflix com'],
      ['UBER *TRIP SAO PAULO SP', 'trip sao paulo'],
      ['Parcela 3/6 - MAGAZINE LUIZA S/A', 'magazine luiza'],
      ['IFD*IFOOD 12345', 'ifood'],
    ];
    for (const [input, expected] of cases) {
      const r = await client.query('SELECT normalize_merchant($1) AS n', [input]);
      expect(r.rows[0].n, input).toBe(expected);
    }
  });

  it('learns the alias from statement_line.raw and stops writing description_memories', async () => {
    const r = await client.query('SELECT * FROM merchant_aliases WHERE raw_normalized = normalize_merchant($1)', [`QWERPO ALIMENTOS LTDA ${ids.tag}`]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].canonical_description).toBe(`Qwerpo ${ids.tag}`);
    expect(r.rows[0].hits).toBe(10);
    const dm = await client.query('SELECT count(*)::int AS n FROM description_memories WHERE description LIKE $1', [`%${ids.tag}%`]);
    expect(dm.rows[0].n).toBe(0);
  });

  it('classify_candidates: raw text and short name land on the same category (Tampopo case)', async () => {
    const raw = await client.query('SELECT * FROM classify_candidates($1, 45.90, $2, CURRENT_DATE, NULL, $1, 3)', [`QWERPO ALIMENTOS LTDA ${ids.tag}`, ids.nu]);
    const short = await client.query('SELECT * FROM classify_candidates($1, NULL, NULL, NULL, NULL, NULL, 3)', [`Qwerpo ${ids.tag}`]);
    expect(raw.rows[0].category_id).toBe(ids.food);
    expect(short.rows[0].category_id).toBe(ids.food);
    expect(Number(raw.rows[0].confidence)).toBeGreaterThanOrEqual(0.8);
    expect(raw.rows[0].factors.alias).toBe(true);
    expect(raw.rows[0].canonical_description).toBe(`Qwerpo ${ids.tag}`);
    expect(raw.rows[0].n_matches).toBe(10);
  });

  it('match_description_memory keeps its shape and description_memories_with_names is derived', async () => {
    const m = await client.query('SELECT * FROM match_description_memory($1)', [`qwerpo ${ids.tag}`]);
    expect(Object.keys(m.rows[0])).toEqual(['description', 'category_id', 'category_name', 'category_type', 'account_id', 'account_name', 'account_type', 'currency', 'similarity', 'score']);
    expect(m.rows[0].account_id).toBe(ids.nu);
    const v = await client.query('SELECT * FROM description_memories_with_names WHERE description = $1', [`Qwerpo ${ids.tag}`]);
    expect(v.rows[0].usage_count).toBe(10);
    expect(v.rows[0].category_id).toBe(ids.food);
  });

  it('reconciliation equation, continuity and locking', async () => {
    const open = (await client.query('SELECT ledger_balance_as_of($1, (CURRENT_DATE - 31)::date) AS b', [ids.nu])).rows[0].b as number;
    const close = (await client.query('SELECT ledger_balance_as_of($1, CURRENT_DATE) AS b', [ids.nu])).rows[0].b as number;
    const r = (
      await client.query('SELECT * FROM open_reconciliation($1, (CURRENT_DATE - 30)::date, CURRENT_DATE, $2, $3, $4, $5, $6)', [ids.nu, open, close - 10, 'BRL', 'stmt-1', 'test'])
    ).rows[0];
    expect(r.status).toBe('open');
    const entries = await client.query(
      `SELECT e.id FROM entries e JOIN transactions t ON t.id = e.transaction_id WHERE e.account_id = $1 AND t.date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE`,
      [ids.nu],
    );
    const items = entries.rows.map((e) => ({ kind: 'cleared', entry_id: e.id }));
    const r2 = (await client.query('SELECT * FROM set_reconciliation_items($1, $2::jsonb)', [r.id, JSON.stringify(items)])).rows[0];
    expect(Number(r2.difference)).toBeCloseTo(-10, 2);
    await client.query('SAVEPOINT s1');
    await expect(client.query("SELECT close_reconciliation($1, 'balanced', NULL, NULL)", [r.id])).rejects.toThrow(/Cannot close as balanced/);
    await client.query('ROLLBACK TO SAVEPOINT s1');

    const aj = (await client.query("SELECT id FROM accounts WHERE parent_id IS NULL AND name = 'ajustes'")).rows[0].id;
    const adj = (
      await client.query('SELECT create_transaction(CURRENT_DATE, $1, $2::jsonb, $3::jsonb) AS t', [
        'Ajuste de conciliação',
        JSON.stringify([
          { account_id: ids.nu, amount: -10, currency: 'BRL', amount_base: -10 },
          { account_id: aj, amount: 10, currency: 'BRL', amount_base: 10 },
        ]),
        JSON.stringify({ source: 'advisor', kind: 'adjust' }),
      ])
    ).rows[0].t;
    const r3 = (await client.query("SELECT * FROM close_reconciliation($1, 'adjusted', $2, 'fee not in OFX')", [r.id, adj.id])).rows[0];
    expect(r3.status).toBe('adjusted');
    const st = (await client.query('SELECT * FROM account_reconciliation_status WHERE account_id = $1', [ids.nu])).rows[0];
    expect(st.reconciled_through).toBeTruthy();
    expect(Number(st.suspense_balance)).toBe(10);
    const ab = (await client.query('SELECT reconciled_through, cleared_balance, last_checked FROM account_balances WHERE account_id = $1', [ids.nu])).rows[0];
    expect(String(ab.reconciled_through)).toBe(String(st.reconciled_through));
    expect(ab.last_checked).toBeTruthy();

    // continuity break on the next period
    const r4 = (
      await client.query('SELECT * FROM open_reconciliation($1, (CURRENT_DATE + 1)::date, (CURRENT_DATE + 30)::date, $2, 0, $3, $4, $5)', [ids.nu, close - 10 + 5, 'BRL', 'stmt-2', 'test'])
    ).rows[0];
    expect(r4.notes).toMatch(/continuity_break/);

    // cleared glyph data
    const twe = await client.query('SELECT clearing FROM transactions_with_entries WHERE $1 = ANY(account_ids) AND clearing IS NOT NULL LIMIT 1', [ids.nu]);
    expect(twe.rows[0].clearing.reconciliation_id).toBe(r.id);
    const unc = await client.query('SELECT count(*)::int AS n FROM uncleared_entries($1, CURRENT_DATE, (CURRENT_DATE - 30)::date)', [ids.nu]);
    expect(unc.rows[0].n).toBe(0);
    ids.rec = r.id;
  });

  it('clearings survive update_transaction when carried over, and the period closes again when it still balances', async () => {
    // pick a cleared transaction in the reconciled period and recategorise it (same amount)
    const row = (
      await client.query(
        `SELECT t.id FROM transactions t JOIN entries e ON e.transaction_id = t.id JOIN reconciliation_items ri ON ri.entry_id = e.id
         WHERE ri.reconciliation_id = $1 AND ri.kind = 'cleared' AND e.account_id = $2 LIMIT 1`,
        [ids.rec, ids.nu],
      )
    ).rows[0];
    const before = (await client.query('SELECT count(*)::int AS n FROM reconciliation_items WHERE reconciliation_id = $1', [ids.rec])).rows[0].n as number;
    await client.query('SELECT reopen_reconciliation($1, $2)', [ids.rec, 'test reopen']);
    const snapshot = await snapshotClearings(client, row.id);
    expect(snapshot.length).toBe(1);
    await client.query('SELECT update_transaction($1, CURRENT_DATE - 3, $2, $3::jsonb, $4::jsonb)', [
      row.id,
      'Recategorised',
      JSON.stringify([
        { account_id: ids.transp, amount: 45.9, currency: 'BRL', amount_base: 45.9 },
        { account_id: ids.nu, amount: -45.9, currency: 'BRL', amount_base: -45.9 },
      ]),
      JSON.stringify({ source: 'advisor' }),
    ]);
    const gone = (await client.query('SELECT count(*)::int AS n FROM reconciliation_items WHERE reconciliation_id = $1', [ids.rec])).rows[0].n as number;
    expect(gone).toBe(before - 1); // the cascade removed the clearing
    const touched = await restoreClearings(client, row.id, snapshot);
    expect(touched).toEqual([ids.rec]);
    const after = (await client.query('SELECT count(*)::int AS n FROM reconciliation_items WHERE reconciliation_id = $1', [ids.rec])).rows[0].n as number;
    expect(after).toBe(before);
    const [state] = await recomputeReconciliations(client, [ids.rec]);
    expect(state!.status).toBe('open');
    // the period had been closed with a R$ 10 adjustment: the difference is still 10, so it closes as adjusted again
    expect(Number(state!.difference)).toBeCloseTo(-10, 2);
    expect(isBalanced(state!)).toBe(false);
    expect(recloseDecision(state!, 'adjusted')).toBe('adjusted');
    expect(recloseDecision(state!, 'balanced')).toBeNull();
    const closed = (await client.query("SELECT * FROM close_reconciliation($1, 'adjusted', $2, 'closed again')", [ids.rec, state!.adjustment_transaction_id])).rows[0];
    expect(closed.status).toBe('adjusted');

    // changing the amount leaves a visible difference instead
    await client.query('SELECT reopen_reconciliation($1, $2)', [ids.rec, 'test reopen 2']);
    const snap2 = await snapshotClearings(client, row.id);
    await client.query('SELECT update_transaction($1, CURRENT_DATE - 3, $2, $3::jsonb, $4::jsonb)', [
      row.id,
      'Recategorised again',
      JSON.stringify([
        { account_id: ids.transp, amount: 50, currency: 'BRL', amount_base: 50 },
        { account_id: ids.nu, amount: -50, currency: 'BRL', amount_base: -50 },
      ]),
      JSON.stringify({ source: 'advisor' }),
    ]);
    await restoreClearings(client, row.id, snap2);
    const [state2] = await recomputeReconciliations(client, [ids.rec]);
    expect(Number(state2!.difference)).toBeCloseTo(-10 + 4.1, 2);
    expect(recloseDecision(state2!, 'adjusted')).toBe('adjusted'); // close_reconciliation then rejects it: the leg no longer equals the difference
    await client.query('SAVEPOINT s2');
    await expect(client.query("SELECT close_reconciliation($1, 'adjusted', $2, 'x')", [ids.rec, state2!.adjustment_transaction_id])).rejects.toThrow(/does not equal the difference/);
    await client.query('ROLLBACK TO SAVEPOINT s2');
    expect(recloseDecision({ ...state2!, difference: 0 }, null)).toBe('balanced');
  });
});

function dateMinus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
