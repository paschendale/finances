import { AUTH_TOKEN_KEY, logout } from './api';

export const ADVISOR_URL = (import.meta.env.VITE_APP_ADVISOR_URL as string | undefined) || 'http://localhost:3100';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ConversationChannel = 'web' | 'discord' | 'system';

export interface Conversation {
  id: string;
  channel: ConversationChannel;
  external_ref: string | null;
  title: string;
  status: 'active' | 'archived';
  created_by: string | null;
  summary: string | null;
  created_at: string;
  last_activity_at: string;
}

export interface ConversationListRow extends Conversation {
  /** A Gmail statement is parsed here and its planning turn has not run yet (waiting for the usage gate) */
  waiting_turn: boolean;
  pending_plans: number;
  last_message: string | null;
  last_message_role: 'user' | 'assistant' | null;
  statement_count: number;
}

export type MessageStatus = 'pending' | 'streaming' | 'done' | 'failed';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  attachments: { statement_id?: string; filename: string }[];
  status: MessageStatus;
  created_at: string;
}

export interface StatementSummary {
  id: string;
  filename: string;
  institution: string | null;
  kind: string;
  format: string;
  status: string;
  period_start: string | null;
  period_end: string | null;
  closing_balance: number | null;
  line_count: number;
}

export type PlanStatus = 'draft' | 'pending_approval' | 'approved' | 'applying' | 'applied' | 'rejected' | 'failed';
export type PlanItemKind = 'create' | 'update' | 'delete' | 'adjust' | 'budget_upsert' | 'budget_delete' | 'mark_checked' | 'skip' | 'account_create' | 'account_update';
export type PlanItemStatus = 'proposed' | 'edited' | 'removed' | 'applied' | 'failed';

export interface BalanceCheck {
  ok: boolean;
  difference: number;
  account_name?: string | null;
  projected?: number;
  statement_closing?: number;
  ledger_opening?: number;
  cleared_total?: number;
  plan_delta?: number;
  outstanding_count?: number;
  outstanding_total?: number;
}

export interface PlanResult {
  balance?: BalanceCheck | null;
  apply?: {
    status: string;
    applied: number;
    failed: number;
    skipped: number;
    failed_items?: { seq: number; kind: string; error: string | null }[];
    reconciliation: { id: string; status: string; difference: number | null; period_end: string; cleared: number; outstanding: number; missing: number; notes: string | null } | null;
  };
}

export interface Plan {
  id: string;
  conversation_id: string;
  statement_id: string | null;
  title: string;
  summary: string | null;
  status: PlanStatus;
  version: number;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  applied_at: string | null;
  result: PlanResult | null;
  created_at: string;
  updated_at: string;
  item_count: number;
  create_count: number;
  update_count: number;
  skip_count: number;
  adjust_count: number;
  min_confidence: number;
}

export interface PlanEntry {
  account_id: string;
  account_name?: string | null;
  account_type?: string | null;
  amount: number;
  currency: string;
  exchange_rate: number;
  amount_base: number;
}

export interface SourceLine {
  hash: string;
  date: string;
  posted_at?: string;
  amount: number;
  currency: string;
  raw: string;
  description_hint: string;
  fitid?: string;
  kind: 'debit' | 'credit';
  balance_after?: number;
  alias?: { canonical_description: string; account_id: string | null } | null;
  candidates?: { category_name: string; score: number; confidence: number }[];
  already_in_ledger?: boolean;
  likely_duplicate?: boolean;
}

export interface PlanItem {
  id: string;
  plan_id: string;
  seq: number;
  kind: PlanItemKind;
  transaction_id: string | null;
  date: string | null;
  description: string | null;
  entries: PlanEntry[];
  payload: Record<string, unknown>;
  source_ref: { statement_id?: string; line_hash?: string; fitid?: string } | null;
  confidence: number | null;
  rationale: string | null;
  status: PlanItemStatus;
  applied_transaction_id: string | null;
  error: string | null;
  source_line: SourceLine | null;
}

export interface PlanDetail {
  plan: Plan;
  items: PlanItem[];
  statement: (Omit<StatementSummary, 'line_count'> & { line_count: number; account_id: string | null }) | null;
  balance: BalanceCheck | null;
}

export interface ApplyResult {
  status: 'applied' | 'failed';
  applied: number;
  failed: number;
  skipped: number;
  items: { id: string; seq: number; kind: string; status: string; transaction_id: string | null; error: string | null }[];
  reconciliation: { reconciliation: { id: string; status: string; difference: number | null; period_end: string; notes: string | null } } | null;
  /** Reconciliations the plan reopened (cleared entries edited), with their state after apply */
  reopened?: { id: string; period_end: string; status: string; difference: number | null }[];
}

export interface AdvisorHealth {
  ok: boolean;
  claude: { loggedIn: boolean; expiresInHours: number | null; error?: string };
  gate: { open: boolean; reason: string } | null;
  pending_plans: number;
}

export interface ReconciliationStatus {
  account_id: string;
  account_name: string;
  reconciled_through: string | null;
  last_status: 'open' | 'balanced' | 'adjusted' | null;
  last_reconciliation_id: string | null;
  open_difference: number;
  suspense_balance: number;
  last_checked: string | null;
}

export type ConversationEvent =
  | { type: 'message'; messageId: string; role: 'user' | 'assistant' | 'system'; content: string; status: MessageStatus }
  | { type: 'text'; messageId: string; delta: string }
  | { type: 'tool'; messageId: string; phase: 'start' | 'end'; id: string; name?: string; summary?: string; isError?: boolean }
  | { type: 'status'; messageId: string; status: 'thinking' | 'streaming' | 'done' | 'failed'; error?: string }
  | { type: 'plan'; planId: string; status: string; version: number }
  | { type: 'conversation'; field: 'title' | 'summary' | 'status'; value: string };

export type GlobalEvent =
  | { type: 'plan'; planId: string; conversationId: string; status: string }
  | { type: 'statement'; statementId: string; conversationId: string | null; status: string }
  | { type: 'health'; claude: boolean }
  | { type: 'conversation_activity'; conversationId: string; event: ConversationEvent };

// ─── HTTP ────────────────────────────────────────────────────────────────────

export class AdvisorApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'AdvisorApiError';
    this.status = status;
    this.body = body;
  }
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}`, ...extra } : extra;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${ADVISOR_URL}${path}`, { ...init, headers: authHeaders({ ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...((init.headers as Record<string, string>) ?? {}) }) });
  if (res.status === 401) {
    logout();
    throw new AdvisorApiError(401, 'Session expired');
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok && res.status !== 207) {
    const msg = (body as { error?: string } | null)?.error ?? res.statusText ?? 'Advisor request failed';
    throw new AdvisorApiError(res.status, msg, body);
  }
  return body as T;
}

export const fetchAdvisorHealth = () => fetch(`${ADVISOR_URL}/health`).then(async (r) => (await r.json()) as AdvisorHealth);
export const fetchConversations = () => request<ConversationListRow[]>('/conversations');
export const fetchConversation = (id: string) => request<{ conversation: Conversation; messages: Message[]; plans: Plan[]; statements: StatementSummary[]; busy: boolean }>(`/conversations/${id}`);
export const createConversation = (input: { title?: string; message?: string; context?: string }) =>
  request<Conversation>('/conversations', { method: 'POST', body: JSON.stringify(input) });
export const patchConversation = (id: string, patch: { title?: string; status?: 'active' | 'archived' }) =>
  request<Conversation>(`/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const sendMessage = (id: string, content: string) =>
  request<{ accepted: boolean; queued: boolean }>(`/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
export const planNow = (id: string) => request<{ started: number }>(`/conversations/${id}/plan-now`, { method: 'POST' });
export const planAllNow = () => request<{ started: number; conversation_ids: string[] }>('/conversations/plan-now', { method: 'POST' });
export const stopConversation = (id: string) => request<{ stopped: boolean }>(`/conversations/${id}/stop`, { method: 'POST' });
export const fetchPlans = (status?: string) => request<Plan[]>(`/plans${status ? `?status=${encodeURIComponent(status)}` : ''}`);
export const fetchPlan = (id: string) => request<PlanDetail>(`/plans/${id}`);
export const patchPlanItem = (planId: string, itemId: string, patch: Partial<Pick<PlanItem, 'kind' | 'date' | 'description' | 'entries' | 'payload'>> & { status?: 'proposed' | 'edited' | 'removed' }) =>
  request<{ item: PlanItem; version: number }>(`/plans/${planId}/items/${itemId}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const approvePlan = (id: string, version: number, keepReopenFlags = false) =>
  request<ApplyResult>(`/plans/${id}/approve`, { method: 'POST', body: JSON.stringify({ version, keep_reopen_flags: keepReopenFlags }) });
export const rejectPlan = (id: string) => request<Plan>(`/plans/${id}/reject`, { method: 'POST' });
export const replan = (id: string, message: string) => request<{ accepted: boolean }>(`/plans/${id}/replan`, { method: 'POST', body: JSON.stringify({ message }) });
export const fetchReconciliationStatus = () => request<ReconciliationStatus[]>('/accounts/reconciliation-status');

export async function uploadFiles(files: File[], opts: { conversationId?: string; message?: string } = {}): Promise<{ conversation_id: string; statements: unknown[] }> {
  const fd = new FormData();
  for (const f of files) fd.append('file', f, f.name);
  if (opts.message) fd.append('message', opts.message);
  const path = opts.conversationId ? `/conversations/${opts.conversationId}/uploads` : '/uploads';
  return request(path, { method: 'POST', body: fd });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const APPROVE_MIN_CONFIDENCE = 0.6;

/** Approve directly from the inline card only when the balance check passes and no item is doubtful. */
export function canApproveFromCard(plan: Pick<Plan, 'status' | 'min_confidence' | 'result'>): boolean {
  if (plan.status !== 'pending_approval') return false;
  const balance = plan.result?.balance ?? null;
  if (balance && !balance.ok) return false;
  return (plan.min_confidence ?? 1) >= APPROVE_MIN_CONFIDENCE;
}

export function channelLabel(c: Pick<Conversation, 'channel' | 'created_by'>): 'Web' | 'Discord' | 'Gmail' | 'Automático' {
  if (c.channel === 'discord') return 'Discord';
  if (c.channel === 'web') return 'Web';
  return c.created_by === 'gmail' ? 'Gmail' : 'Automático';
}

export const formatBRL = (n: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);

// ─── SSE ─────────────────────────────────────────────────────────────────────

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental text/event-stream parser. Feed chunks, get complete events back; keeps the
 * unterminated tail for the next chunk.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const out: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const ev = parseSseBlock(block);
      if (ev) out.push(ev);
    }
    return out;
  }
}

export function parseSseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  let id: string | undefined;
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n'), id };
}

/**
 * Subscribes to an advisor SSE endpoint with fetch + ReadableStream (EventSource cannot send
 * the Authorization header). Reconnects with backoff until unsubscribed.
 */
export function subscribe(path: string, onEvent: (ev: SseEvent) => void, onStateChange?: (connected: boolean) => void): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let attempt = 0;

  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`${ADVISOR_URL}${path}`, { headers: authHeaders({ Accept: 'text/event-stream' }), signal: controller.signal });
        if (res.status === 401) { logout(); return; }
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        attempt = 0;
        onStateChange?.(true);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const ev of parser.push(decoder.decode(value, { stream: true }))) onEvent(ev);
        }
      } catch {
        /* reconnect below */
      }
      onStateChange?.(false);
      if (stopped) return;
      attempt++;
      await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** Math.min(attempt, 5))));
    }
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
