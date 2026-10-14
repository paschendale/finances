#!/usr/bin/env node
// Fake `claude` binary for tests: replays recorded stream-json. Mode via FAKE_CLAUDE_MODE.
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
const sid = 'fake-session-1';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (mode === 'hang') {
  out({ type: 'system', subtype: 'init', session_id: sid });
  setInterval(() => {}, 1000);
} else if (mode === 'error') {
  out({ type: 'system', subtype: 'init', session_id: sid });
  out({ type: 'result', subtype: 'error_during_execution', session_id: sid, is_error: true, result: 'Not logged in. Please run /login', usage: {}, total_cost_usd: 0 });
  process.exit(1);
} else {
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus' });
  out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__advisor__list_account_balances', input: {} }] } });
  out({ type: 'user', session_id: sid, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } });
  for (const piece of ['O saldo da ', 'conta é ', '**R$ 24,20**.']) {
    out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
  }
  out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'O saldo da conta é **R$ 24,20**.' }] } });
  out({
    type: 'result',
    subtype: 'success',
    session_id: sid,
    is_error: false,
    result: 'O saldo da conta é **R$ 24,20**.',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, output_tokens: 12 },
    num_turns: 2,
    duration_ms: 1200,
  });
  process.exit(0);
}
