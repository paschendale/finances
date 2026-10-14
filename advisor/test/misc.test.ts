import { describe, expect, it } from 'vitest';
import { ConversationLocks, SessionPool } from '../src/claude/pool.js';
import { assertDatabaseMatchesEnv, databaseNameOf, loadConfig } from '../src/config.js';
import { detectCheckin, parseBrazilianAmount } from '../src/jobs/checkin.js';
import { APPROVE_WORDS, REJECT_WORDS, chunkMessage, discordify } from '../src/discord/poster.js';
import { humanizeError, describeTool } from '../src/claude/session.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SessionPool', () => {
  it('gives interactive turns N slots and background one extra slot that yields to waiting people', async () => {
    const pool = new SessionPool(2);
    const r1 = await pool.acquire('interactive');
    const r2 = await pool.acquire('interactive');
    let bgStarted = false;
    const bg = pool.acquire('background').then((rel) => {
      bgStarted = true;
      return rel;
    });
    await sleep(20);
    expect(bgStarted).toBe(false); // every interactive slot is busy: background waits
    r1();
    const relBg = await bg;
    expect(bgStarted).toBe(true);
    // a person arrives: gets the free interactive slot right away, never queued behind background
    const r3 = await pool.acquire('interactive');
    let bg2Started = false;
    const bg2 = pool.acquire('background').then((rel) => {
      bg2Started = true;
      return rel;
    });
    await sleep(20);
    expect(bg2Started).toBe(false); // only one background slot
    // a second person waits for a slot; background must not start while they wait
    let i4Started = false;
    const i4 = pool.acquire('interactive').then((rel) => {
      i4Started = true;
      return rel;
    });
    relBg();
    await sleep(20);
    expect(bg2Started).toBe(false);
    expect(i4Started).toBe(false);
    r2();
    await i4;
    expect(i4Started).toBe(true);
    r3();
    await sleep(20);
    expect(bg2Started).toBe(true);
    (await bg2)();
    (await i4)();
    expect(pool.stats).toEqual({ interactiveActive: 0, interactiveWaiting: 0, backgroundActive: 0 });
  });
});

describe('ConversationLocks', () => {
  it('serialises turns per conversation and frees the lock', async () => {
    const locks = new ConversationLocks();
    const order: string[] = [];
    const a = locks.run('c1', async () => {
      order.push('a-start');
      await sleep(30);
      order.push('a-end');
    });
    const b = locks.run('c1', async () => {
      order.push('b-start');
    });
    const c = locks.run('c2', async () => {
      order.push('c-start');
    });
    expect(locks.isBusy('c1')).toBe(true);
    await Promise.all([a, b, c]);
    expect(order.indexOf('b-start')).toBeGreaterThan(order.indexOf('a-end'));
    expect(order.indexOf('c-start')).toBeLessThan(order.indexOf('a-end'));
    expect(locks.isBusy('c1')).toBe(false);
  });
});

describe('config safety rails', () => {
  it('extracts the database name', () => {
    expect(databaseNameOf('postgres://u:p@host:5432/finances-dev?sslmode=require')).toBe('finances-dev');
  });
  it('refuses prod env on a non-prod database and vice versa', () => {
    expect(() => assertDatabaseMatchesEnv('prod', 'postgres://u:p@h/finances-dev', 'finances')).toThrow(/ADVISOR_ENV=prod/);
    expect(() => assertDatabaseMatchesEnv('dev', 'postgres://u:p@h/finances', 'finances')).toThrow(/production database/);
    expect(() => assertDatabaseMatchesEnv('prod', 'postgres://u:p@h/finances', 'finances')).not.toThrow();
  });
  it('requires channel secrets only when the channel is enabled', () => {
    const base = { DATABASE_URL: 'postgres://u:p@h/finances-dev', POSTGREST_URL: 'http://pg:3000', FINANCES_TOKEN: 't', JWT_SECRET: 's' };
    expect(() => loadConfig({ ...base, ADVISOR_CHANNELS: 'web' })).not.toThrow();
    expect(() => loadConfig({ ...base, ADVISOR_CHANNELS: 'web,discord' })).toThrow(/DISCORD_BOT_TOKEN/);
    const c = loadConfig({ ...base, ADVISOR_CHANNELS: 'web', PUBLIC_WEB_ORIGINS: 'https://a.example, https://b.example' });
    expect(c.webOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(c.PORT).toBe(3100);
  });
});

describe('check-in detection', () => {
  it('parses Brazilian amounts', () => {
    expect(parseBrazilianAmount('657,21')).toBe(657.21);
    expect(parseBrazilianAmount('1.546,74')).toBe(1546.74);
    expect(parseBrazilianAmount('R$ 24,20')).toBe(24.2);
    expect(parseBrazilianAmount('1200')).toBe(1200);
  });
  it('detects casual balance statements', () => {
    expect(detectCheckin('Nubank tá com 657,21')).toEqual({ accountHint: 'Nubank', amount: 657.21 });
    expect(detectCheckin('o itaú está em R$ 1.546,74')).toEqual({ accountHint: 'itaú', amount: 1546.74 });
    expect(detectCheckin('quanto gastei em outubro?')).toBeNull();
  });
});

describe('discord poster', () => {
  it('chunks on paragraph boundaries under 2000 chars', () => {
    const text = Array.from({ length: 60 }, (_, i) => `linha ${i} ${'x'.repeat(50)}`).join('\n\n');
    const chunks = chunkMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1990);
    expect(chunks.join('\n\n').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });
  it('wraps markdown tables in code blocks', () => {
    const out = discordify('intro\n| a | b |\n|---|---|\n| 1 | 2 |\nfim');
    expect(out).toContain('```');
    expect(out.split('```').length).toBe(3);
  });
  it('recognises approval words', () => {
    expect(APPROVE_WORDS.test('aprova')).toBe(true);
    expect(APPROVE_WORDS.test('pode aplicar')).toBe(true);
    expect(REJECT_WORDS.test('rejeita isso')).toBe(true);
    expect(APPROVE_WORDS.test('quanto foi o mercado?')).toBe(false);
  });
});

describe('session helpers', () => {
  it('humanizes login and limit errors', () => {
    expect(humanizeError('Not logged in', '')).toMatch(/claude login/);
    expect(humanizeError(null, 'Error: rate limit reached, resets at 15:30')).toMatch(/usage limit/i);
  });
  it('describes tool calls briefly', () => {
    expect(describeTool('mcp__advisor__ledger_balance_as_of', { date: '2026-09-30' })).toBe('checking balance as of 2026-09-30');
    expect(describeTool('Bash', { command: 'python3 -c "print(1)"' })).toMatch(/^running python3/);
  });
});
