import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { StreamParser, runSession, sessionArgs, childEnv, type RunnerEvent } from '../src/claude/runner.js';

const fixture = path.resolve(__dirname, 'fixtures/fake-claude.mjs');

describe('StreamParser', () => {
  it('collects session id, text deltas, tool activity and the result', () => {
    const events: RunnerEvent[] = [];
    const p = new StreamParser((e) => events.push(e));
    const lines = [
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'stream_event', session_id: 'sess-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Olá' } } },
      { type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text: 'Olá' }, { type: 'tool_use', id: 't1', name: 'mcp__advisor__statement_get', input: { id: 'x' } }] } },
      { type: 'user', session_id: 'sess-1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } },
      { type: 'stream_event', session_id: 'sess-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ', tudo bem' } } },
      { type: 'result', subtype: 'success', session_id: 'sess-1', is_error: false, result: 'Olá, tudo bem', total_cost_usd: 0.01, usage: { output_tokens: 3 }, num_turns: 2 },
    ];
    p.push(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    p.end();
    expect(p.sessionId).toBe('sess-1');
    expect(p.text).toBe('Olá, tudo bem');
    expect(p.result?.total_cost_usd).toBe(0.01);
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Olá, tudo bem');
  });

  it('falls back to assistant message text without partial deltas and survives split chunks', () => {
    const p = new StreamParser();
    const line = JSON.stringify({ type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'no deltas here' }] } }) + '\n';
    p.push(line.slice(0, 20));
    p.push(line.slice(20));
    p.push('garbage that is not json\n');
    p.end();
    expect(p.text).toBe('no deltas here');
  });
});

describe('sessionArgs / childEnv', () => {
  it('builds the documented command line', () => {
    const args = sessionArgs({
      bin: 'claude',
      message: 'hi',
      cwd: '/ws',
      mcpConfigPath: '/runs/x.json',
      systemPromptFile: '/p/advisor.system.md',
      model: 'opus',
      effort: 'high',
      resumeSessionId: 'abc',
      timeoutMs: 1000,
    });
    expect(args.slice(0, 2)).toEqual(['-p', 'hi']);
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--include-partial-messages');
    expect(args[args.indexOf('--resume') + 1]).toBe('abc');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).toContain('mcp__advisor__*');
    expect(args).toContain('Write');
  });
  it('strips secrets from the child environment', () => {
    const env = childEnv({}, { HOME: '/h', PATH: '/bin', DATABASE_URL: 'secret', DISCORD_BOT_TOKEN: 'x', CLAUDE_CODE_SOMETHING: 'y', TZ: 'America/Sao_Paulo' });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_SOMETHING).toBeUndefined();
    expect(env.TZ).toBe('America/Sao_Paulo');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });
});

describe('runSession with a fake claude binary', () => {
  it('replays recorded stream-json and reports usage', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'advisor-runner-'));
    const events: RunnerEvent[] = [];
    const r = await runSession({
      bin: fixture,
      message: 'qual o saldo?',
      cwd: dir,
      mcpConfigPath: path.join(dir, 'mcp.json'),
      systemPromptFile: path.join(dir, 'sys.md'),
      model: 'opus',
      effort: 'high',
      timeoutMs: 20_000,
      onEvent: (e) => events.push(e),
      env: { FAKE_CLAUDE_MODE: 'ok' },
    });
    expect(r.isError).toBe(false);
    expect(r.sessionId).toBe('fake-session-1');
    expect(r.text).toContain('R$ 24,20');
    expect(r.costUsd).toBeCloseTo(0.0123);
    expect(events.some((e) => e.type === 'tool_start')).toBe(true);
  });

  it('kills the process on timeout', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'advisor-runner-'));
    const r = await runSession({
      bin: fixture,
      message: 'hang',
      cwd: dir,
      mcpConfigPath: path.join(dir, 'mcp.json'),
      systemPromptFile: path.join(dir, 'sys.md'),
      model: 'opus',
      effort: 'high',
      timeoutMs: 1_500,
      env: { FAKE_CLAUDE_MODE: 'hang' },
    });
    expect(r.timedOut).toBe(true);
    expect(r.isError).toBe(true);
    expect(r.errorMessage).toMatch(/timed out/);
  });

  it('reports an error result', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'advisor-runner-'));
    const r = await runSession({
      bin: fixture,
      message: 'fail',
      cwd: dir,
      mcpConfigPath: path.join(dir, 'mcp.json'),
      systemPromptFile: path.join(dir, 'sys.md'),
      model: 'opus',
      effort: 'high',
      timeoutMs: 20_000,
      env: { FAKE_CLAUDE_MODE: 'error' },
    });
    expect(r.isError).toBe(true);
    expect(r.errorMessage).toMatch(/not logged in/i);
  });
});

describe('StreamParser text blocks', () => {
  it('keeps a blank line between text blocks separated by tool calls', () => {
    const deltas: string[] = [];
    const p = new StreamParser((ev) => { if (ev.type === 'text') deltas.push(ev.delta); });
    const line = (o: unknown) => JSON.stringify(o) + '\n';
    p.push(line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }));
    p.push(line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Resolvi a conta.' } } }));
    p.push(line({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } } }));
    p.push(line({ type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'text' } } }));
    p.push(line({ type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Plano pronto.' } } }));
    p.end();
    expect(p.text).toBe('Resolvi a conta.\n\nPlano pronto.');
    expect(deltas.join('')).toBe(p.text);
  });
});
