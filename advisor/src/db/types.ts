export type ConversationChannel = 'web' | 'discord' | 'system';
export type ConversationStatus = 'active' | 'archived';

export interface Conversation {
  id: string;
  channel: ConversationChannel;
  external_ref: string | null;
  title: string;
  claude_session_id: string | null;
  model: string | null;
  created_by: string | null;
  summary: string | null;
  status: ConversationStatus;
  created_at: string;
  last_activity_at: string;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type MessageStatus = 'pending' | 'streaming' | 'done' | 'failed';

export interface Attachment {
  statement_id?: string;
  filename: string;
  format?: string;
  size?: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  attachments: Attachment[];
  status: MessageStatus;
  created_at: string;
}

export type StatementSource = 'gmail' | 'upload';
export type StatementKind = 'account' | 'card' | 'investment' | 'other';
export type StatementFormat = 'ofx' | 'csv' | 'pdf' | 'image' | 'xlsx' | 'other';
export type StatementStatus = 'received' | 'parsed' | 'planned' | 'applied' | 'ignored' | 'failed';

export interface StatementLineCandidate {
  category_id: string;
  category_name: string;
  score: number;
  confidence: number;
}

export interface StatementLine {
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
  counterparty?: string;
  alias?: { canonical_description: string; account_id: string | null };
  candidates?: StatementLineCandidate[];
  already_in_ledger?: boolean;
  ledger_transaction_id?: string;
  likely_duplicate?: boolean;
  duplicate_candidate_id?: string;
  installment?: { current: number; total: number };
}

export interface Statement {
  id: string;
  account_id: string | null;
  source: StatementSource;
  institution: string | null;
  kind: StatementKind;
  format: StatementFormat;
  filename: string;
  sha256: string;
  storage_path: string | null;
  gmail_message_id: string | null;
  period_start: string | null;
  period_end: string | null;
  currency: string | null;
  opening_balance: number | null;
  closing_balance: number | null;
  lines: StatementLine[] | null;
  status: StatementStatus;
  error: string | null;
  conversation_id: string | null;
  created_at: string;
}

export type PlanStatus = 'draft' | 'pending_approval' | 'approved' | 'applying' | 'applied' | 'rejected' | 'failed';
export type PlanItemKind = 'create' | 'update' | 'delete' | 'adjust' | 'budget_upsert' | 'budget_delete' | 'mark_checked' | 'skip';
export type PlanItemStatus = 'proposed' | 'edited' | 'removed' | 'applied' | 'failed';

export interface PlanEntry {
  account_id: string;
  amount: number;
  currency: string;
  exchange_rate: number;
  amount_base: number;
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
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface PlanWithCounts extends Plan {
  item_count: number;
  create_count: number;
  update_count: number;
  skip_count: number;
  adjust_count: number;
  min_confidence: number;
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
  updated_at: string;
}

export interface Note {
  id: string;
  scope: 'global' | 'account' | 'category';
  ref_id: string | null;
  note: string;
  created_by: string | null;
  created_at: string;
}

export interface ClaudeCall {
  id: string;
  conversation_id: string | null;
  claude_session_id: string | null;
  mode: 'session' | 'single';
  model: string | null;
  started_at: string;
  duration_ms: number | null;
  exit_code: number | null;
  usage: Record<string, unknown> | null;
  cost_usd: number | null;
  error: string | null;
}

export interface Reconciliation {
  id: string;
  account_id: string;
  period_start: string;
  period_end: string;
  currency: string | null;
  statement_opening: number | null;
  statement_closing: number;
  ledger_opening: number | null;
  ledger_closing: number | null;
  cleared_total: number;
  outstanding_total: number;
  difference: number | null;
  status: 'open' | 'balanced' | 'adjusted' | 'abandoned';
  adjustment_transaction_id: string | null;
  statement_ref: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  closed_at: string | null;
}
