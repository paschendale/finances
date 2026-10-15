import { describe, expect, it } from 'vitest';
import { ConversationLocks, SessionPool } from '../src/claude/pool.js';
import { assertDatabaseMatchesEnv, databaseNameOf, loadConfig } from '../src/config.js';
import { detectCheckin, parseBrazilianAmount } from '../src/jobs/checkin.js';
import { APPROVE_WORDS, REJECT_WORDS, chunkMessage, discordify, headline, mobileify, trackerText } from '../src/discord/poster.js';
import { parseTracker } from '../src/discord/bot.js';
import { dueReason, shouldNudge } from '../src/jobs/nudges.js';
import { humanizeError, describeTool } from '../src/claude/session.js';
import { originMatcher } from '../src/http/server.js';
import { accountConversationKey, accountConversationTitle } from '../src/gmail/grouping.js';
import { buildPlanningMessage, groupByPeriod, type WaitingStatement } from '../src/jobs/background-turns.js';

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
  it('lays text out for a phone: one paragraph per line, headings bold, code blocks intact', () => {
    const out = mobileify('## Título\nlinha 1\nlinha 2\n\n\n```\na\nb\n```\nfim');
    expect(out).toBe('**Título**\n\nlinha 1\n\nlinha 2\n\n```\na\nb\n```\n\nfim');
  });
  it('extracts a headline from a reply', () => {
    expect(headline('**O plano está pronto.** Nada foi gravado ainda.\n\nmais texto')).toBe('O plano está pronto.');
    expect(headline('x'.repeat(200), 50).length).toBeLessThanOrEqual(50);
    expect(headline('| a | b |\n\nResposta aqui')).toBe('Resposta aqui');
  });
  it('builds and parses tracker messages', () => {
    const text = trackerText({ title: 'Extrato set/2026', status: '🟡 Plano aguardando aprovação', lines: ['16 novos · 21 já no ledger', ''], hint: 'Detalhes na thread.', link: 'https://app.example/?view=advisor' });
    expect(text.split('\n\n')).toEqual(['**Extrato set/2026**', '🟡 Plano aguardando aprovação', '16 novos · 21 já no ledger', 'Detalhes na thread.', '<https://app.example/?view=advisor>']);
    expect(parseTracker(text)).toEqual({ title: 'Extrato set/2026', status: '🟡 Plano aguardando aprovação', hint: 'Detalhes na thread.', link: 'https://app.example/?view=advisor' });
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
    expect(humanizeError('Not logged in', '')).toMatch(/login do Claude/);
    expect(humanizeError(null, 'Error: rate limit reached, resets at 15:30')).toMatch(/limite de uso/i);
  });
  it('describes tool calls briefly', () => {
    expect(describeTool('mcp__advisor__ledger_balance_as_of', { date: '2026-09-30' })).toBe('conferindo o saldo em 30/09');
    expect(describeTool('Bash', { command: 'python3 -c "print(1)"' })).toBe('fazendo uma conta');
  });
});

describe('originMatcher', () => {
  it('matches exact, wildcard-label and star patterns', () => {
    expect(originMatcher('https://a.example')('https://a.example')).toBe(true);
    expect(originMatcher('https://a.example')('https://b.example')).toBe(false);
    const m = originMatcher('https://*.finances-94t.pages.dev');
    expect(m('https://8bdff01c.finances-94t.pages.dev')).toBe(true);
    expect(m('https://advisor.finances-94t.pages.dev')).toBe(true);
    expect(m('https://evil.com/?x=.finances-94t.pages.dev')).toBe(false);
    expect(originMatcher('*')('anything')).toBe(true);
  });
});

describe('nudges', () => {
  const now = Date.parse('2026-10-15T15:00:00Z');
  it('posts the first time and whenever a new account becomes due', () => {
    expect(shouldNudge([], null, '2026-10-15', now)).toBe(false);
    expect(shouldNudge(['a'], null, '2026-10-15', now)).toBe(true);
    expect(shouldNudge(['a', 'b'], { day: '2026-10-14', accounts: ['a'], posted_at: '2026-10-14T15:00:00Z' }, '2026-10-15', now)).toBe(true);
  });
  it('repeats the same list only after a week, never twice a day', () => {
    const last = { day: '2026-10-12', accounts: ['a', 'b'], posted_at: '2026-10-12T15:00:00Z' };
    expect(shouldNudge(['a'], last, '2026-10-15', now)).toBe(false);
    expect(shouldNudge(['a'], { ...last, day: '2026-10-08', posted_at: '2026-10-08T15:00:00Z' }, '2026-10-15', now)).toBe(true);
    expect(shouldNudge(['c'], { ...last, day: '2026-10-15' }, '2026-10-15', now)).toBe(false);
  });
  it('reads the state written before posted_at existed', () => {
    expect(shouldNudge(['a'], { day: '2026-10-01', accounts: ['a'] }, '2026-10-15', now)).toBe(true);
    expect(shouldNudge(['a'], { day: '2026-10-14', accounts: ['a'] }, '2026-10-15', now)).toBe(false);
  });
  it('says why an account is due', () => {
    expect(dueReason({ check_reason: 'moved', days_since_check: 34 })).toBe('teve movimento depois da última conferência');
    expect(dueReason({ check_reason: 'cadence', days_since_check: 35 })).toBe('conferida há 35 dias');
    expect(dueReason({ check_reason: 'never_checked', days_since_check: null })).toBe('nunca conferida');
  });
});

describe('gmail grouping', () => {
  const base = { account_id: null, institution: 'nubank', kind: 'account' as const };
  it('keys a conversation by the ledger account, else by institution and kind', () => {
    expect(accountConversationKey({ ...base, account_id: 'acc-1' })).toBe('gmail:acc-1');
    expect(accountConversationKey(base)).toBe('gmail:nubank:account');
    expect(accountConversationKey({ account_id: null, institution: null, kind: 'card' })).toBe('gmail:desconhecido:card');
  });

  it('titles the conversation with the span of its periods', () => {
    expect(accountConversationTitle(base, [])).toBe('Nubank conta');
    expect(accountConversationTitle({ institution: 'nubank', kind: 'card' }, [{ period_start: '2026-09-01', period_end: '2026-09-30' }])).toBe('Nubank cartão · 01/09/2026 a 30/09/2026');
    expect(
      accountConversationTitle(base, [
        { period_start: '2026-08-01', period_end: '2026-08-31' },
        { period_start: '2026-07-01', period_end: '2026-07-31' },
        { period_start: '2026-09-01', period_end: '2026-09-30' },
      ]),
    ).toBe('Nubank conta · 01/07/2026 a 30/09/2026');
  });

  const stmt = (over: Partial<WaitingStatement>): WaitingStatement =>
    ({
      id: 'id',
      account_id: null,
      source: 'gmail',
      institution: 'nubank',
      kind: 'account',
      format: 'ofx',
      filename: 'f.ofx',
      sha256: 'x',
      storage_path: null,
      gmail_message_id: null,
      period_start: '2026-07-01',
      period_end: '2026-07-31',
      currency: 'BRL',
      opening_balance: 10,
      closing_balance: 20,
      lines: [{ hash: 'h', date: '2026-07-02', amount: -5, currency: 'BRL', raw: 'X', description_hint: 'X', kind: 'debit' }],
      status: 'parsed',
      error: null,
      conversation_id: 'conv',
      created_at: '2026-10-15T10:00:00Z',
      conversation_created_by: 'gmail',
      ...over,
    }) as WaitingStatement;

  it('groups several formats of one period together and sorts periods oldest first', () => {
    const groups = groupByPeriod([
      stmt({ id: 'sep-csv', format: 'csv', filename: 's.csv', period_start: '2026-09-01', period_end: '2026-09-30' }),
      stmt({ id: 'sep-ofx', period_start: '2026-09-01', period_end: '2026-09-30' }),
      stmt({ id: 'jul', period_start: '2026-07-01', period_end: '2026-07-31' }),
    ]);
    expect(groups.map((g) => g.primary.id)).toEqual(['jul', 'sep-ofx']);
    expect(groups[1]!.others.map((s) => s.id)).toEqual(['sep-csv']);
  });

  it('writes the single-period message as before and a chronological list for several periods', () => {
    const one = buildPlanningMessage([stmt({ id: 'jul' }), stmt({ id: 'jul-pdf', format: 'pdf', filename: 'f.pdf' })]);
    expect(one.primary.id).toBe('jul');
    expect(one.text).toContain('Statement jul received');
    expect(one.text).toContain('cross-check');

    const many = buildPlanningMessage([
      stmt({ id: 'aug', period_start: '2026-08-01', period_end: '2026-08-31', account_id: 'acc-1' }),
      stmt({ id: 'jul', account_id: 'acc-1' }),
      stmt({ id: 'bad', status: 'failed', error: 'boom', period_start: '2026-09-01', period_end: '2026-09-30', lines: null }),
    ]);
    expect(many.primary.id).toBe('jul');
    expect(many.text).toMatch(/^3 statement periods of the same account/);
    expect(many.text).toContain('Ledger account: acc-1.');
    expect(many.text.indexOf('Statement jul')).toBeLessThan(many.text.indexOf('Statement aug'));
    expect(many.text).toContain('Statement bad (f.ofx): could not be parsed (boom)');
    expect(many.text).toContain('continuity');
  });
});
