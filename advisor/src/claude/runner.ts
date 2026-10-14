import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scoped } from '../log.js';

const log = scoped('claude.runner');

export type RunnerEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; isError: boolean }
  | { type: 'status'; status: string };

export interface SessionRunOptions {
  bin: string;
  message: string;
  cwd: string;
  mcpConfigPath: string;
  systemPromptFile: string;
  model: string;
  effort: string;
  resumeSessionId?: string | null;
  timeoutMs: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  env?: Record<string, string>;
  onEvent?: (ev: RunnerEvent) => void;
  signal?: AbortSignal;
}

export interface RunResult {
  sessionId: string | null;
  text: string;
  usage: Record<string, unknown> | null;
  costUsd: number | null;
  exitCode: number | null;
  isError: boolean;
  errorMessage: string | null;
  durationMs: number;
  numTurns: number | null;
  timedOut: boolean;
  stderr: string;
}

export const DEFAULT_ALLOWED_TOOLS = [
  'mcp__advisor__*',
  'Read',
  'Glob',
  'Grep',
  'Bash(python3 *)',
  'Bash(pdftotext *)',
  'Bash(ls *)',
  'Bash(head *)',
  'Bash(wc *)',
];

export const DEFAULT_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent'];

/** Child environment: nothing from the daemon's secrets reaches the `claude` process. */
export function childEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    HOME: base.HOME ?? '/home/advisor',
    PATH: base.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    TZ: base.TZ ?? 'UTC',
    LANG: base.LANG ?? 'C.UTF-8',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  if (base.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = base.CLAUDE_CONFIG_DIR;
  if (base.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = base.NODE_EXTRA_CA_CERTS;
  return { ...env, ...extra };
}

export function resolveBin(bin: string): string {
  if (bin.includes('/')) return bin;
  const home = process.env.HOME ?? '';
  for (const dir of (process.env.PATH ?? '').split(':').concat([`${home}/.local/bin`, '/usr/local/bin', '/opt/homebrew/bin'])) {
    const p = path.join(dir, bin);
    if (dir && fs.existsSync(p)) return p;
  }
  return bin;
}

interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  status?: string;
  event?: { type?: string; index?: number; delta?: { type?: string; text?: string }; content_block?: { type?: string } };
  parent_tool_use_id?: string | null;
  message?: { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean }> };
  is_error?: boolean;
  result?: string;
  usage?: Record<string, unknown>;
  total_cost_usd?: number;
  num_turns?: number;
  structured_output?: unknown;
}

/**
 * Incremental parser for `--output-format stream-json --verbose --include-partial-messages`.
 * Text comes from text deltas when present, else from assistant messages (fake claude in tests).
 */
export class StreamParser {
  sessionId: string | null = null;
  text = '';
  private deltaText = '';
  private messageText = '';
  private sawDelta = false;
  result: StreamLine | null = null;
  private buffer = '';

  constructor(private readonly onEvent?: (ev: RunnerEvent) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleLine(line);
    }
  }

  end(): void {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) this.handleLine(rest);
    this.text = this.sawDelta ? this.deltaText : this.messageText;
  }

  private handleLine(line: string): void {
    let j: StreamLine;
    try {
      j = JSON.parse(line) as StreamLine;
    } catch {
      return; // non-JSON noise on stdout
    }
    if (j.session_id && !this.sessionId) {
      this.sessionId = j.session_id;
      this.onEvent?.({ type: 'init', sessionId: j.session_id });
    }
    switch (j.type) {
      case 'system':
        if (j.subtype === 'status' && j.status) this.onEvent?.({ type: 'status', status: j.status });
        break;
      case 'stream_event': {
        const ev = j.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string' && !j.parent_tool_use_id) {
          this.sawDelta = true;
          this.deltaText += ev.delta.text;
          this.onEvent?.({ type: 'text', delta: ev.delta.text });
        }
        break;
      }
      case 'assistant': {
        for (const block of j.message?.content ?? []) {
          if (block.type === 'text' && typeof block.text === 'string' && !j.parent_tool_use_id) {
            this.messageText += (this.messageText ? '\n\n' : '') + block.text;
            if (!this.sawDelta) this.onEvent?.({ type: 'text', delta: (this.messageText.endsWith(block.text) && this.messageText !== block.text ? '\n\n' : '') + block.text });
          } else if (block.type === 'tool_use' && block.id && block.name) {
            this.onEvent?.({ type: 'tool_start', id: block.id, name: block.name, input: block.input });
          }
        }
        break;
      }
      case 'user': {
        for (const block of j.message?.content ?? []) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            this.onEvent?.({ type: 'tool_end', id: block.tool_use_id, isError: Boolean(block.is_error) });
          }
        }
        break;
      }
      case 'result':
        this.result = j;
        break;
      default:
        break;
    }
  }
}

export function sessionArgs(o: SessionRunOptions): string[] {
  const args = [
    '-p',
    o.message,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    o.model,
    '--effort',
    o.effort,
    '--append-system-prompt-file',
    o.systemPromptFile,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    o.mcpConfigPath,
    '--allowedTools',
    ...(o.allowedTools ?? DEFAULT_ALLOWED_TOOLS),
    '--disallowedTools',
    ...(o.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS),
    '--permission-mode',
    'default',
    '--permission-prompts',
    'none',
    '--add-dir',
    o.cwd,
  ];
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
  return args;
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export async function runSession(o: SessionRunOptions): Promise<RunResult> {
  const started = Date.now();
  const parser = new StreamParser(o.onEvent);
  const bin = resolveBin(o.bin);
  const args = sessionArgs(o);
  log.debug({ bin, cwd: o.cwd, model: o.model, resume: Boolean(o.resumeSessionId) }, 'spawning claude session turn');

  return new Promise<RunResult>((resolve) => {
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(bin, args, { cwd: o.cwd, env: childEnv(o.env), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, 'SIGTERM');
      setTimeout(() => killTree(child.pid, 'SIGKILL'), 5_000).unref();
    }, o.timeoutMs);
    const onAbort = () => {
      killTree(child.pid, 'SIGTERM');
      setTimeout(() => killTree(child.pid, 'SIGKILL'), 5_000).unref();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => parser.push(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr += d;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    const finish = (exitCode: number | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      parser.end();
      const r = parser.result;
      const isError = Boolean(spawnError) || timedOut || Boolean(r?.is_error) || (exitCode !== 0 && exitCode !== null) || (!r && !o.signal?.aborted);
      let errorMessage: string | null = null;
      if (spawnError) errorMessage = spawnError.message;
      else if (timedOut) errorMessage = `claude timed out after ${Math.round(o.timeoutMs / 1000)}s`;
      else if (o.signal?.aborted) errorMessage = 'stopped by user';
      else if (r?.is_error) errorMessage = r.result ?? r.subtype ?? 'claude reported an error';
      else if (!r) errorMessage = `claude exited (${exitCode}) without a result event: ${stderr.trim().slice(-500)}`;
      resolve({
        sessionId: parser.sessionId ?? r?.session_id ?? null,
        text: parser.text || (r?.result && !r.is_error ? r.result : ''),
        usage: r?.usage ?? null,
        costUsd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null,
        exitCode,
        isError,
        errorMessage,
        durationMs: Date.now() - started,
        numTurns: r?.num_turns ?? null,
        timedOut,
        stderr,
      });
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code));
  });
}

// ---- single-shot (Sonnet) ----------------------------------------------------------------

export interface SingleShotOptions {
  bin: string;
  systemPrompt: string;
  jsonSchema: Record<string, unknown>;
  input: unknown;
  model: string;
  effort?: string;
  timeoutMs: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface SingleShotResult {
  value: unknown;
  usage: Record<string, unknown> | null;
  costUsd: number | null;
  sessionId: string | null;
  durationMs: number;
  exitCode: number | null;
}

export function singleShotArgs(o: SingleShotOptions): string[] {
  return [
    '-p',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(o.jsonSchema),
    '--model',
    o.model,
    '--effort',
    o.effort ?? 'medium',
    '--tools',
    '',
    '--allowedTools',
    'StructuredOutput',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    '',
    '--system-prompt',
    o.systemPrompt,
    '--permission-mode',
    'default',
    '--permission-prompts',
    'none',
  ];
}

export async function runSingleShot(o: SingleShotOptions): Promise<SingleShotResult> {
  const started = Date.now();
  const bin = resolveBin(o.bin);
  return new Promise<SingleShotResult>((resolve, reject) => {
    const child = spawn(bin, singleShotArgs(o), { cwd: o.cwd, env: childEnv(o.env), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      killTree(child.pid, 'SIGKILL');
      reject(new Error(`claude single-shot timed out after ${Math.round(o.timeoutMs / 1000)}s`));
    }, o.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const meta = JSON.parse(stdout) as StreamLine;
        if (meta.is_error) throw new Error(`claude error: ${meta.result ?? meta.subtype ?? 'unknown'}`);
        let value: unknown = meta.structured_output;
        if (value === undefined) {
          const text = meta.result ?? '';
          const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
          value = JSON.parse(m ? m[1]! : text);
        }
        resolve({
          value,
          usage: meta.usage ?? null,
          costUsd: typeof meta.total_cost_usd === 'number' ? meta.total_cost_usd : null,
          sessionId: meta.session_id ?? null,
          durationMs: Date.now() - started,
          exitCode: code,
        });
      } catch (e) {
        reject(new Error(`${(e as Error).message}; exit ${code}; stderr: ${stderr.trim().slice(-400)}`));
      }
    });
    child.stdin.end(typeof o.input === 'string' ? o.input : JSON.stringify(o.input));
  });
}
