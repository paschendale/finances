-- Migration 0048: advisor tables
--
-- State for the AI advisor daemon (advisor/). Everything the daemon persists lives in
-- these advisor_* tables; the ledger itself is only touched through the existing RPCs.

CREATE TABLE IF NOT EXISTS advisor_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS advisor_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source      TEXT NOT NULL CHECK (source IN ('discord', 'gmail', 'web', 'scheduler')),
  external_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS advisor_conversations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel           TEXT NOT NULL CHECK (channel IN ('web', 'discord', 'system')),
  external_ref      TEXT,
  title             TEXT NOT NULL DEFAULT 'Conversation',
  claude_session_id TEXT,
  model             TEXT,
  created_by        TEXT,
  summary           TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_advisor_conversations_activity ON advisor_conversations (last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_advisor_conversations_external ON advisor_conversations (channel, external_ref);

CREATE TABLE IF NOT EXISTS advisor_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES advisor_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content         TEXT NOT NULL DEFAULT '',
  attachments     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'streaming', 'done', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_advisor_messages_conversation ON advisor_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS advisor_statements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID REFERENCES accounts(id),
  source           TEXT NOT NULL CHECK (source IN ('gmail', 'upload')),
  institution      TEXT,
  kind             TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('account', 'card', 'investment', 'other')),
  format           TEXT NOT NULL CHECK (format IN ('ofx', 'csv', 'pdf', 'image', 'xlsx', 'other')),
  filename         TEXT NOT NULL,
  sha256           TEXT NOT NULL UNIQUE,
  storage_path     TEXT,
  gmail_message_id TEXT,
  period_start     DATE,
  period_end       DATE,
  currency         TEXT,
  opening_balance  NUMERIC,
  closing_balance  NUMERIC,
  lines            JSONB,
  status           TEXT NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received', 'parsed', 'planned', 'applied', 'ignored', 'failed')),
  error            TEXT,
  conversation_id  UUID REFERENCES advisor_conversations(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_advisor_statements_status ON advisor_statements (status);
CREATE INDEX IF NOT EXISTS idx_advisor_statements_conversation ON advisor_statements (conversation_id);

CREATE TABLE IF NOT EXISTS advisor_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES advisor_conversations(id) ON DELETE CASCADE,
  statement_id    UUID REFERENCES advisor_statements(id) ON DELETE SET NULL,
  title           TEXT NOT NULL DEFAULT 'Plan',
  summary         TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'pending_approval', 'approved', 'applying', 'applied', 'rejected', 'failed')),
  version         INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT,
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  applied_at      TIMESTAMPTZ,
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_advisor_plans_conversation ON advisor_plans (conversation_id);
CREATE INDEX IF NOT EXISTS idx_advisor_plans_status ON advisor_plans (status);

CREATE TABLE IF NOT EXISTS advisor_plan_items (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id                UUID NOT NULL REFERENCES advisor_plans(id) ON DELETE CASCADE,
  seq                    INTEGER NOT NULL,
  kind                   TEXT NOT NULL
                         CHECK (kind IN ('create', 'update', 'delete', 'adjust', 'budget_upsert', 'budget_delete', 'mark_checked', 'skip')),
  transaction_id         UUID,
  date                   DATE,
  description            TEXT,
  entries                JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload                JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_ref             JSONB,
  confidence             NUMERIC,
  rationale              TEXT,
  status                 TEXT NOT NULL DEFAULT 'proposed'
                         CHECK (status IN ('proposed', 'edited', 'removed', 'applied', 'failed')),
  applied_transaction_id UUID,
  error                  TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_id, seq)
);

CREATE TABLE IF NOT EXISTS advisor_notes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope      TEXT NOT NULL CHECK (scope IN ('global', 'account', 'category')),
  ref_id     UUID,
  note       TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_advisor_notes_scope ON advisor_notes (scope, ref_id);

CREATE TABLE IF NOT EXISTS advisor_claude_calls (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID REFERENCES advisor_conversations(id) ON DELETE SET NULL,
  claude_session_id TEXT,
  mode              TEXT NOT NULL CHECK (mode IN ('session', 'single')),
  model             TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms       INTEGER,
  exit_code         INTEGER,
  usage             JSONB,
  cost_usd          NUMERIC,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_advisor_claude_calls_started ON advisor_claude_calls (started_at DESC);

CREATE TABLE IF NOT EXISTS advisor_usage_snapshots (
  id                   BIGSERIAL PRIMARY KEY,
  at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  five_hour_pct        NUMERIC,
  five_hour_resets_at  TIMESTAMPTZ,
  seven_day_pct        NUMERIC,
  seven_day_resets_at  TIMESTAMPTZ,
  locked               BOOLEAN NOT NULL DEFAULT false,
  decision             TEXT,
  reason               TEXT
);

CREATE OR REPLACE VIEW advisor_plans_with_counts AS
SELECT
  p.*,
  COALESCE((SELECT count(*) FROM advisor_plan_items i WHERE i.plan_id = p.id AND i.status <> 'removed'), 0)::int AS item_count,
  COALESCE((SELECT count(*) FROM advisor_plan_items i WHERE i.plan_id = p.id AND i.status <> 'removed' AND i.kind = 'create'), 0)::int AS create_count,
  COALESCE((SELECT count(*) FROM advisor_plan_items i WHERE i.plan_id = p.id AND i.status <> 'removed' AND i.kind = 'update'), 0)::int AS update_count,
  COALESCE((SELECT count(*) FROM advisor_plan_items i WHERE i.plan_id = p.id AND i.status <> 'removed' AND i.kind = 'skip'), 0)::int AS skip_count,
  COALESCE((SELECT count(*) FROM advisor_plan_items i WHERE i.plan_id = p.id AND i.status <> 'removed' AND i.kind = 'adjust'), 0)::int AS adjust_count,
  COALESCE((SELECT min(i.confidence) FROM advisor_plan_items i WHERE i.plan_id = p.id AND i.status <> 'removed' AND i.kind <> 'skip'), 1) AS min_confidence
FROM advisor_plans p;

GRANT ALL ON advisor_state, advisor_events, advisor_conversations, advisor_messages, advisor_statements,
  advisor_plans, advisor_plan_items, advisor_notes, advisor_claude_calls, advisor_usage_snapshots TO authenticated;
GRANT SELECT ON advisor_plans_with_counts TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE advisor_usage_snapshots_id_seq TO authenticated;

NOTIFY pgrst, 'reload schema';
