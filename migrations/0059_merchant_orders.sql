-- 0059_merchant_orders.sql
-- Orders read from store mails (Amazon today): what was bought, for how much, and which card
-- charges paid for it. The advisor uses them to name and categorise generic "Amazon" charges.

CREATE TABLE IF NOT EXISTS merchant_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant          TEXT NOT NULL,
  order_ref         TEXT NOT NULL,
  ordered_at        TIMESTAMPTZ NOT NULL,
  items             JSONB NOT NULL DEFAULT '[]'::jsonb,
  total             NUMERIC(14, 2),
  currency          TEXT NOT NULL DEFAULT 'BRL',
  gmail_message_ids TEXT[] NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'matched', 'ignored')),
  -- [{transaction_id, amount, items: [index], action: 'enriched' | 'linked', at}]
  charges           JSONB NOT NULL DEFAULT '[]'::jsonb,
  reported_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant, order_ref)
);

CREATE INDEX IF NOT EXISTS idx_merchant_orders_open ON merchant_orders (status, ordered_at);

GRANT ALL ON merchant_orders TO authenticated;
