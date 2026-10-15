import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { Bus } from '../events.js';
import type { McpTokenRegistry } from '../mcp/tokens.js';
import type { Attachment, Conversation, Message, Statement } from '../db/types.js';
import { addMessage, getConversation, listMessages, updateConversation, updateMessage } from '../db/repo/conversations.js';
import { recordClaudeCall } from '../db/repo/misc.js';
import { listStatements } from '../db/repo/statements.js';
import { ConversationLocks, SessionPool } from './pool.js';
import { runSession, type RunnerEvent } from './runner.js';
import { CAPABILITIES_VERSION } from '../mcp/tools/advisor.js';
import { scoped } from '../log.js';

const log = scoped('claude.session');

export interface SessionDeps {
  config: Config;
  db: Db;
  bus: Bus;
  mcpTokens: McpTokenRegistry;
  pool: SessionPool;
  locks: ConversationLocks;
  promptsDir: string;
}

export interface TurnOptions {
  actor: string | null;
  kind: 'interactive' | 'background';
  attachments?: Attachment[];
  /** Hidden context prepended to the message (not shown as the user's text). */
  context?: string;
  /** Message to persist as the user's text; defaults to `content`. */
  display?: string;
  /** Per-turn timeout; planning turns over a whole statement get a longer one than chat. */
  timeoutMs?: number;
}

export interface TurnOutcome {
  userMessage: Message;
  assistantMessage: Message;
  ok: boolean;
  error: string | null;
}

/** Short progress line for a tool call, shown under the streaming message. */
export function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const short = name.replace(/^mcp__advisor__/, '');
  const q = (v: unknown, n = 40) => `“${String(v ?? '').slice(0, n)}”`;
  switch (short) {
    case 'statement_lines':
      return `lendo o extrato (linhas ${Number(i.offset ?? 0) + 1} a ${Number(i.offset ?? 0) + Number(i.limit ?? 50)})`;
    case 'statement_get':
      return 'lendo o extrato';
    case 'classify_candidates':
      return `procurando a categoria de ${q(i.description ?? i.raw)}`;
    case 'ledger_balance_as_of':
      return `conferindo o saldo em ${fmtDayBR(i.date)}`;
    case 'list_transactions':
      return `olhando os lançamentos${i.start_date ? ` de ${fmtDayBR(i.start_date)} a ${fmtDayBR(i.end_date)}` : ''}`;
    case 'list_account_balances':
      return 'lendo os saldos das contas';
    case 'list_accounts_hierarchical':
      return 'lendo a lista de contas e categorias';
    case 'match_account':
      return `procurando a conta ${q(i.input, 30)}`;
    case 'match_description_memory':
    case 'list_description_memories':
      return 'lembrando como você costuma registrar';
    case 'plan_create':
      return 'começando um plano';
    case 'plan_set_items':
      return `montando o plano (${Array.isArray(i.items) ? i.items.length : ''} itens)`;
    case 'plan_finalize':
      return 'fechando o plano para você aprovar';
    case 'plan_get':
    case 'plan_list':
      return 'relendo o plano';
    case 'reconciliation_history':
    case 'reconciliation_get':
    case 'account_reconciliation_status':
      return 'olhando as conferências anteriores';
    case 'uncleared_entries':
      return 'listando lançamentos ainda não conferidos';
    case 'note_list':
      return 'lendo anotações';
    case 'note_add':
      return 'guardando uma anotação';
    case 'merchant_alias_get':
      return 'lembrando o nome que você usa';
    case 'merchant_alias_set':
      return `aprendendo o nome ${q(i.canonical_description)}`;
    case 'get_category_totals':
    case 'get_category_monthly_history':
      return 'somando os gastos por categoria';
    case 'get_dashboard_data':
    case 'get_monthly_balances':
    case 'get_daily_balances':
    case 'list_daily_account_balances':
      return 'olhando a evolução dos saldos';
    case 'list_budget_plans':
    case 'list_budget_items':
    case 'list_budget_monthly_spending':
      return 'lendo o orçamento';
    case 'conversation_summary_set':
      return 'anotando um resumo da conversa';
    case 'Bash':
      return 'fazendo uma conta';
    case 'Read':
      return `lendo ${path.basename(String(i.file_path ?? ''))}`;
    case 'Grep':
    case 'Glob':
      return 'procurando nos arquivos';
    default:
      return `consultando ${short.replace(/_/g, ' ')}`;
  }
}

function fmtDayBR(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  return m ? `${m[3]}/${m[2]}` : String(v ?? '');
}

export class SessionManager {
  private aborts = new Map<string, AbortController>();

  constructor(private readonly deps: SessionDeps) {}

  workspaceDir(conversationId: string): string {
    return path.join(this.deps.config.DATA_DIR, 'workspaces', conversationId);
  }

  statementsDir(conversationId: string): string {
    return path.join(this.workspaceDir(conversationId), 'statements');
  }

  private runsDir(): string {
    return path.join(this.deps.config.DATA_DIR, 'runs');
  }

  async ensureWorkspace(conversationId: string): Promise<string> {
    const dir = this.workspaceDir(conversationId);
    await fs.mkdir(path.join(dir, 'statements'), { recursive: true });
    await this.writeReadme(conversationId);
    return dir;
  }

  async writeReadme(conversationId: string): Promise<void> {
    const dir = this.workspaceDir(conversationId);
    const statements = await listStatements(this.deps.db, { conversation_id: conversationId });
    const lines = [
      'Advisor workspace for this conversation.',
      'statements/ holds the files the user or the mailbox provided plus <id>.lines.csv with the normalized lines.',
      'Use Python (python3) only for arithmetic and CSV crunching; ledger facts come from the MCP tools.',
      '',
      statements.length ? 'Statements:' : 'No statements yet.',
      ...statements.map(
        (s) => `- ${s.id}  ${s.institution ?? '?'}/${s.kind}  ${s.filename}  period ${s.period_start ?? '?'}..${s.period_end ?? '?'}  status ${s.status}  file statements/${s.id}${path.extname(s.filename).toLowerCase()}`,
      ),
    ];
    await fs.writeFile(path.join(dir, 'README.txt'), lines.join('\n') + '\n', 'utf8');
  }

  /** Copies a statement file (and its normalized CSV) into the conversation workspace. */
  async attachStatement(conversationId: string, statement: Statement, sourcePath: string, linesCsv: string | null): Promise<string> {
    await this.ensureWorkspace(conversationId);
    const ext = path.extname(statement.filename).toLowerCase() || `.${statement.format}`;
    const dest = path.join(this.statementsDir(conversationId), `${statement.id}${ext}`);
    await fs.copyFile(sourcePath, dest);
    if (linesCsv) await fs.writeFile(path.join(this.statementsDir(conversationId), `${statement.id}.lines.csv`), linesCsv, 'utf8');
    await this.writeReadme(conversationId);
    return dest;
  }

  isBusy(conversationId: string): boolean {
    return this.deps.locks.isBusy(conversationId);
  }

  stop(conversationId: string): boolean {
    const ac = this.aborts.get(conversationId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  /**
   * One user turn: persist the message, run `claude -p` (resuming the conversation's session),
   * stream deltas and tool activity on the bus, persist the reply, log the call.
   */
  async sendUserMessage(conversationId: string, content: string, opts: TurnOptions): Promise<TurnOutcome> {
    const { db, bus, config } = this.deps;
    const conv = await getConversation(db, conversationId);
    if (!conv) throw new Error(`conversation ${conversationId} not found`);

    const userMessage = await addMessage(db, { conversation_id: conversationId, role: 'user', content: opts.display ?? content, attachments: opts.attachments ?? [] });
    bus.emitConversation(conversationId, { type: 'message', messageId: userMessage.id, role: 'user', content: userMessage.content, status: 'done' });
    if (conv.title === 'Conversation' && (opts.display ?? content).trim()) {
      const title = (opts.display ?? content).trim().replace(/\s+/g, ' ').slice(0, 60);
      await updateConversation(db, conversationId, { title });
      bus.emitConversation(conversationId, { type: 'conversation', field: 'title', value: title });
    }

    const assistantMessage = await addMessage(db, { conversation_id: conversationId, role: 'assistant', content: '', status: 'pending' });
    bus.emitConversation(conversationId, { type: 'message', messageId: assistantMessage.id, role: 'assistant', content: '', status: 'pending' });

    return this.deps.locks.run(conversationId, async () => {
      const release = await this.deps.pool.acquire(opts.kind);
      const ac = new AbortController();
      this.aborts.set(conversationId, ac);
      const started = new Date();
      let mcpToken: string | null = null;
      try {
        bus.emitConversation(conversationId, { type: 'status', messageId: assistantMessage.id, status: 'thinking' });
        const fresh = (await getConversation(db, conversationId))!;
        const cwd = await this.ensureWorkspace(conversationId);
        const session = this.deps.mcpTokens.mint(conversationId, opts.actor);
        mcpToken = session.token;
        await fs.mkdir(this.runsDir(), { recursive: true });
        const mcpConfigPath = path.join(this.runsDir(), `${conversationId}.mcp.json`);
        await fs.writeFile(
          mcpConfigPath,
          JSON.stringify({
            mcpServers: {
              advisor: { type: 'http', url: `http://127.0.0.1:${config.MCP_PORT}/mcp`, headers: { Authorization: `Bearer ${session.token}` } },
            },
          }),
          { mode: 0o600 },
        );

        // A resumed Claude session keeps the tool set it started with, so when the prompt or tools
        // changed we start a new session and hand it the recent transcript instead of resuming.
        const promptHash = await this.currentPromptHash();
        const capabilitiesChanged = Boolean(fresh.claude_session_id) && fresh.prompt_hash !== promptHash;
        const transcript = capabilitiesChanged ? await this.recentTranscript(conversationId, userMessage.id) : null;
        if (capabilitiesChanged) log.info({ conversationId, from: fresh.prompt_hash, to: promptHash }, 'capabilities changed; starting a fresh session with transcript');
        const message = this.composeMessage(fresh, content, opts, cwd, transcript);
        let streamed = '';
        const onEvent = (ev: RunnerEvent) => {
          switch (ev.type) {
            case 'text':
              streamed += ev.delta;
              bus.emitConversation(conversationId, { type: 'text', messageId: assistantMessage.id, delta: ev.delta });
              break;
            case 'tool_start':
              bus.emitConversation(conversationId, { type: 'tool', messageId: assistantMessage.id, phase: 'start', id: ev.id, name: ev.name, summary: describeTool(ev.name, ev.input) });
              break;
            case 'tool_end':
              bus.emitConversation(conversationId, { type: 'tool', messageId: assistantMessage.id, phase: 'end', id: ev.id, isError: ev.isError });
              break;
            case 'status':
              bus.emitConversation(conversationId, { type: 'status', messageId: assistantMessage.id, status: 'streaming' });
              break;
            default:
              break;
          }
        };

        const result = await runSession({
          bin: config.CLAUDE_BIN,
          message,
          cwd,
          mcpConfigPath,
          systemPromptFile: path.join(this.deps.promptsDir, 'advisor.system.md'),
          model: fresh.model ?? config.SESSION_MODEL,
          effort: config.SESSION_EFFORT,
          resumeSessionId: capabilitiesChanged ? null : fresh.claude_session_id,
          timeoutMs: opts.timeoutMs ?? config.SESSION_TIMEOUT_MS,
          onEvent,
          signal: ac.signal,
        });

        await fs.rm(mcpConfigPath, { force: true });

        if (result.sessionId && result.sessionId !== fresh.claude_session_id) {
          await updateConversation(db, conversationId, { claude_session_id: result.sessionId, model: fresh.model ?? config.SESSION_MODEL, prompt_hash: promptHash });
        } else if (fresh.prompt_hash !== promptHash) {
          await updateConversation(db, conversationId, { prompt_hash: promptHash });
        }
        await recordClaudeCall(db, {
          conversation_id: conversationId,
          claude_session_id: result.sessionId,
          mode: 'session',
          model: fresh.model ?? config.SESSION_MODEL,
          started_at: started,
          duration_ms: result.durationMs,
          exit_code: result.exitCode,
          usage: result.usage,
          cost_usd: result.costUsd,
          error: result.isError ? result.errorMessage : null,
        });

        const text = (result.text || streamed).trim();
        if (result.isError && !text) {
          const msg = humanizeError(result.errorMessage, result.stderr);
          await updateMessage(db, assistantMessage.id, { content: msg, status: 'failed' });
          bus.emitConversation(conversationId, { type: 'status', messageId: assistantMessage.id, status: 'failed', error: msg });
          bus.emitConversation(conversationId, { type: 'message', messageId: assistantMessage.id, role: 'assistant', content: msg, status: 'failed' });
          log.warn({ conversationId, error: result.errorMessage, stderr: result.stderr.slice(-500) }, 'session turn failed');
          return { userMessage, assistantMessage: { ...assistantMessage, content: msg, status: 'failed' }, ok: false, error: msg };
        }
        const finalText = result.isError && result.errorMessage ? `${text}\n\n_(${result.errorMessage})_` : text;
        await updateMessage(db, assistantMessage.id, { content: finalText, status: 'done' });
        bus.emitConversation(conversationId, { type: 'status', messageId: assistantMessage.id, status: 'done' });
        bus.emitConversation(conversationId, { type: 'message', messageId: assistantMessage.id, role: 'assistant', content: finalText, status: 'done' });
        return { userMessage, assistantMessage: { ...assistantMessage, content: finalText, status: 'done' }, ok: !result.isError, error: result.isError ? result.errorMessage : null };
      } catch (err) {
        const msg = `The advisor could not run: ${(err as Error).message}`;
        await updateMessage(db, assistantMessage.id, { content: msg, status: 'failed' });
        bus.emitConversation(conversationId, { type: 'status', messageId: assistantMessage.id, status: 'failed', error: msg });
        bus.emitConversation(conversationId, { type: 'message', messageId: assistantMessage.id, role: 'assistant', content: msg, status: 'failed' });
        log.error({ conversationId, err }, 'session turn crashed');
        return { userMessage, assistantMessage: { ...assistantMessage, content: msg, status: 'failed' }, ok: false, error: msg };
      } finally {
        if (mcpToken) this.deps.mcpTokens.revoke(mcpToken);
        this.aborts.delete(conversationId);
        release();
      }
    });
  }

  /** sha256 of the system prompt plus the tool-set version; stored per conversation (migration 0053). */
  private promptHashCache: { mtimeMs: number; hash: string } | null = null;
  async currentPromptHash(): Promise<string> {
    const file = path.join(this.deps.promptsDir, 'advisor.system.md');
    const stat = await fs.stat(file);
    if (this.promptHashCache && this.promptHashCache.mtimeMs === stat.mtimeMs) return this.promptHashCache.hash;
    const text = await fs.readFile(file, 'utf8');
    const hash = createHash('sha256').update(text).update('\n').update(CAPABILITIES_VERSION).digest('hex').slice(0, 16);
    this.promptHashCache = { mtimeMs: stat.mtimeMs, hash };
    return hash;
  }

  /** The last turns of the conversation, for a fresh session that replaces a resumed one. */
  private async recentTranscript(conversationId: string, excludeMessageId: string, maxMessages = 12, maxChars = 1500): Promise<string> {
    const all = (await listMessages(this.deps.db, conversationId)).filter((m) => m.id !== excludeMessageId && (m.role === 'user' || m.role === 'assistant') && m.status !== 'failed');
    const recent = all.slice(-maxMessages);
    const lines = recent.map((m) => {
      const text = m.content.replace(/\s+/g, ' ').trim();
      return `${m.role === 'user' ? 'user' : 'you'}: ${text.length > maxChars ? `${text.slice(0, maxChars)}…` : text}`;
    });
    return lines.join('\n');
  }

  private composeMessage(conv: Conversation, content: string, opts: TurnOptions, cwd: string, transcript: string | null = null): string {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: this.deps.config.TZ }); // YYYY-MM-DD
    const header = [
      `[context] today=${today} tz=${this.deps.config.TZ} channel=${conv.channel} conversation_id=${conv.id} workspace=${cwd}`,
      opts.actor ? `[context] from=${opts.actor}` : null,
      (!conv.claude_session_id || transcript !== null) && conv.summary ? `[context] summary=${conv.summary}` : null,
      transcript !== null
        ? `[context] This conversation continues in a new session because your instructions and tools were updated; what you said earlier about your limits may no longer hold. Recent turns:\n${transcript}`
        : null,
      opts.context ? `[context] ${opts.context}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    const attach = (opts.attachments ?? [])
      .filter((a) => a.statement_id)
      .map((a) => `[attachment] statement_id=${a.statement_id} file=statements/${a.statement_id}${path.extname(a.filename).toLowerCase()} lines=statements/${a.statement_id}.lines.csv`)
      .join('\n');
    return [header, attach, '', content].filter((x) => x !== null).join('\n').trim();
  }
}

export function humanizeError(error: string | null, stderr: string): string {
  const all = `${error ?? ''}\n${stderr}`;
  if (/not logged in|login|authentication|OAuth token|credentials/i.test(all)) {
    return 'O assistente perdeu o acesso ao Claude. É preciso refazer o login do Claude no servidor do assistente (veja o aviso no Discord ou o advisor/README.md) e tentar de novo.';
  }
  if (/rate limit|usage limit|out of (extra )?usage|resets at/i.test(all)) {
    const when = (all.match(/resets? (at|in)[^.\n]*/i) ?? [''])[0];
    return `O limite de uso do Claude foi atingido por enquanto. ${when ? `Volta ${when.replace(/^resets? /i, '')}.` : 'Tente mais tarde.'}`.trim();
  }
  if (/timed out/i.test(all)) return 'O assistente demorou demais e a resposta foi interrompida. Tente de novo.';
  return `O assistente não conseguiu responder: ${error ?? 'erro desconhecido'}`;
}
