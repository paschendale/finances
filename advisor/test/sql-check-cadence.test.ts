/**
 * SQL-level tests for migration 0057 (account_check_status) against a throwaway database
 * (TEST_DATABASE_URL with all migrations applied). Everything runs inside one transaction that is
 * rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;

interface Status {
  check_tier: string | null;
  check_due: boolean;
  check_due_on: string | null;
  check_reason: string | null;
}

describe.skipIf(!url)('migration 0057: when an account is due for a check', () => {
  let client: pg.PoolClient;
  let pool: pg.Pool;
  let src: string;
  let tag: string;

  const mk = async (name: string, type = 'asset', subtype = 'checking') =>
    (await client.query('INSERT INTO accounts (name, type, subtype) VALUES ($1,$2,$3) RETURNING id', [`${name}-${tag}`, type, subtype])).rows[0].id as string;
  const move = (account: string, daysAgo: number, amount: number) =>
    client.query('SELECT create_transaction($1::date, $2, $3::jsonb, $4::jsonb)', [
      dateMinus(daysAgo),
      `cadence ${tag}`,
      JSON.stringify([
        { account_id: account, amount, currency: 'BRL', amount_base: amount },
        { account_id: src, amount: -amount, currency: 'BRL', amount_base: -amount },
      ]),
      '{}',
    ]);
  const checkedDaysAgo = (account: string, days: number) =>
    client.query(`UPDATE accounts SET last_checked = now() - ($2 || ' days')::interval WHERE id = $1`, [account, String(days)]);
  const status = async (account: string): Promise<Status> =>
    (await client.query('SELECT check_tier, check_due, check_due_on::text, check_reason FROM account_balances WHERE account_id = $1', [account])).rows[0];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 1 });
    client = await pool.connect();
    await client.query('BEGIN');
    tag = Math.random().toString(36).slice(2, 8);
    src = await mk('t-cadence-equity', 'equity', null as unknown as string);
  });

  afterAll(async () => {
    await client?.query('ROLLBACK');
    client?.release();
    await pool?.end();
  });

  it('busy accounts: every 30 days, new entries alone do not make them due', async () => {
    const busy = await mk('t-busy');
    for (let i = 1; i <= 10; i++) await move(busy, i * 2, 10);
    await checkedDaysAgo(busy, 5);
    expect(await status(busy)).toMatchObject({ check_tier: 'active', check_due: false, check_due_on: dateMinus(5 - 30) });
    await checkedDaysAgo(busy, 31);
    expect(await status(busy)).toMatchObject({ check_tier: 'active', check_due: true, check_reason: 'cadence' });
  });

  it('occasional accounts: due 7 days after they move, else every 90 days', async () => {
    const occ = await mk('t-occasional');
    await move(occ, 40, 100);
    await checkedDaysAgo(occ, 30);
    expect(await status(occ)).toMatchObject({ check_tier: 'occasional', check_due: false, check_due_on: dateMinus(30 - 90) });
    await move(occ, 3, 50); // a transfer in after the check
    expect(await status(occ)).toMatchObject({ check_due: false, check_due_on: dateMinus(3 - 7), check_reason: 'moved' });
    await move(occ, 10, 20);
    expect(await status(occ)).toMatchObject({ check_due: true, check_reason: 'moved' });
  });

  it('idle accounts: every 180 days with money, never when empty, awake again after a transfer', async () => {
    const money = await mk('t-idle-money', 'asset', 'investments');
    await move(money, 120, 1000);
    await checkedDaysAgo(money, 100);
    expect(await status(money)).toMatchObject({ check_tier: 'dormant', check_due: false, check_due_on: dateMinus(100 - 180) });

    const empty = await mk('t-idle-empty');
    await move(empty, 150, 80);
    await move(empty, 120, -80);
    expect(await status(empty)).toMatchObject({ check_tier: 'dormant_empty', check_due: false, check_due_on: null, check_reason: null });
    await move(empty, 8, 30);
    expect(await status(empty)).toMatchObject({ check_tier: 'occasional', check_due: true, check_reason: 'never_checked' });
  });

  it('property, switched-off and fixed cadences', async () => {
    const flat = await mk('t-apartamento', 'asset', 'property');
    await move(flat, 20, 100000);
    expect(await status(flat)).toMatchObject({ check_tier: 'never', check_due: false, check_due_on: null });

    const off = await mk('t-off');
    for (let i = 1; i <= 10; i++) await move(off, i, 5);
    await client.query('UPDATE accounts SET check_every_days = 0 WHERE id = $1', [off]);
    expect(await status(off)).toMatchObject({ check_tier: 'never', check_due: false });

    await client.query('UPDATE accounts SET check_every_days = 10 WHERE id = $1', [off]);
    await checkedDaysAgo(off, 11);
    expect(await status(off)).toMatchObject({ check_tier: 'fixed', check_due: true, check_reason: 'cadence' });

    const cat = await mk('t-cadence-cat', 'expense', 'category');
    expect(await status(cat)).toMatchObject({ check_tier: null, check_due: false });
  });
});

function dateMinus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
