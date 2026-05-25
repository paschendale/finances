-- Migration 0039: Budget plans and budget items tables

CREATE TABLE IF NOT EXISTS budget_plans (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    period_start DATE NOT NULL,
    period_end   DATE NOT NULL,
    is_current   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budget_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id       UUID NOT NULL REFERENCES budget_plans(id) ON DELETE CASCADE,
    account_id    UUID NOT NULL REFERENCES accounts(id),
    period_amount NUMERIC NOT NULL DEFAULT 0,
    min_pct       NUMERIC NOT NULL DEFAULT 60,
    max_pct       NUMERIC NOT NULL DEFAULT 140,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (plan_id, account_id),
    CHECK (min_pct >= 0),
    CHECK (max_pct >= min_pct)
);

NOTIFY pgrst, 'reload schema';
