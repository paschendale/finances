-- Migration 0051: reconciliations (docs/ADVISOR.md §5.5, §8)
--
-- Bank reconciliation as a first-class ledger resource: one row per account per statement
-- period, items that vouch for ledger entries (cleared), list entries the statement did not
-- show (outstanding), statement lines the ledger lacks (missing), duplicates and adjustments.
--
--   difference = statement_closing − (ledger_opening + Σ cleared)
--   balanced  ⇔ |difference| < 0.005
--
-- Continuity: a statement's opening balance must equal the previous balanced reconciliation's
-- closing balance; a mismatch is recorded in notes and returned, never silently accepted.

CREATE TABLE IF NOT EXISTS reconciliations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                UUID NOT NULL REFERENCES accounts(id),
  period_start              DATE NOT NULL,
  period_end                DATE NOT NULL,
  currency                  TEXT,
  statement_opening         NUMERIC,
  statement_closing         NUMERIC NOT NULL,
  ledger_opening            NUMERIC,
  ledger_closing            NUMERIC,
  cleared_total             NUMERIC NOT NULL DEFAULT 0,
  outstanding_total         NUMERIC NOT NULL DEFAULT 0,
  difference                NUMERIC,
  status                    TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'balanced', 'adjusted', 'abandoned')),
  adjustment_transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  statement_ref             TEXT,
  notes                     TEXT,
  created_by                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at                 TIMESTAMPTZ,
  CHECK (period_end >= period_start)
);
CREATE INDEX IF NOT EXISTS idx_reconciliations_account_period ON reconciliations (account_id, period_end DESC);

CREATE TABLE IF NOT EXISTS reconciliation_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id   UUID NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('cleared', 'outstanding', 'missing', 'duplicate', 'adjustment')),
  entry_id            UUID REFERENCES entries(id) ON DELETE CASCADE,
  statement_line_hash TEXT,
  amount              NUMERIC,
  note                TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_items_entry
  ON reconciliation_items (reconciliation_id, entry_id) WHERE entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reconciliation_items_entry_id ON reconciliation_items (entry_id);

GRANT ALL ON reconciliations, reconciliation_items TO authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_balance_as_of(p_account_id UUID, p_date DATE)
RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(e.amount_base), 0)
  FROM entries e
  JOIN transactions t ON t.id = e.transaction_id
  WHERE e.account_id = p_account_id AND t.date <= p_date;
$$;
GRANT EXECUTE ON FUNCTION ledger_balance_as_of(UUID, DATE) TO authenticated;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW entry_clearings AS
SELECT ri.entry_id, ri.reconciliation_id, r.period_end, r.account_id, r.statement_ref, r.status
FROM reconciliation_items ri
JOIN reconciliations r ON r.id = ri.reconciliation_id
WHERE ri.kind IN ('cleared', 'adjustment') AND ri.entry_id IS NOT NULL AND r.status <> 'abandoned';
GRANT SELECT ON entry_clearings TO authenticated;

CREATE OR REPLACE VIEW account_reconciliation_status AS
WITH ajustes AS (
  SELECT id FROM accounts WHERE parent_id IS NULL AND name = 'ajustes' LIMIT 1
),
last_closed AS (
  SELECT DISTINCT ON (r.account_id) r.account_id, r.period_end, r.status, r.closed_at
  FROM reconciliations r
  WHERE r.status IN ('balanced', 'adjusted')
  ORDER BY r.account_id, r.period_end DESC, r.closed_at DESC
),
last_any AS (
  SELECT DISTINCT ON (r.account_id) r.account_id, r.id, r.status, r.difference, r.period_end
  FROM reconciliations r
  WHERE r.status <> 'abandoned'
  ORDER BY r.account_id, r.period_end DESC, r.created_at DESC
),
suspense AS (
  -- ajustes legs of transactions that also touch the account
  SELECT ea.account_id, COALESCE(SUM(ej.amount_base), 0) AS suspense_balance
  FROM entries ej
  JOIN ajustes aj ON aj.id = ej.account_id
  JOIN entries ea ON ea.transaction_id = ej.transaction_id AND ea.account_id <> ej.account_id
  GROUP BY ea.account_id
)
SELECT
  a.id                      AS account_id,
  lc.period_end             AS reconciled_through,
  la.status                 AS last_status,
  la.id                     AS last_reconciliation_id,
  CASE WHEN la.status = 'open' THEN la.difference ELSE 0 END AS open_difference,
  COALESCE(s.suspense_balance, 0) AS suspense_balance
FROM accounts a
LEFT JOIN last_closed lc ON lc.account_id = a.id
LEFT JOIN last_any la ON la.account_id = a.id
LEFT JOIN suspense s ON s.account_id = a.id
WHERE a.type IN ('asset', 'liability');
GRANT SELECT ON account_reconciliation_status TO authenticated;

-- account_balances: append reconciled_through and cleared_balance (0038 shape kept).
CREATE OR REPLACE VIEW account_balances AS
WITH account_own_data AS (
    SELECT
        a.id,
        COALESCE(SUM(e.amount_base) FILTER (WHERE t.date <= CURRENT_DATE), 0) AS own_balance,
        COALESCE(SUM(e.amount_base) FILTER (WHERE t.date > CURRENT_DATE), 0)  AS future_own_balance,
        MAX(t.date) FILTER (WHERE t.date <= CURRENT_DATE)                      AS own_last_entry_date
    FROM accounts a
    LEFT JOIN entries e ON a.id = e.account_id
    LEFT JOIN transactions t ON e.transaction_id = t.id
    GROUP BY a.id
),
cleared AS (
    SELECT e.account_id, COALESCE(SUM(e.amount_base), 0) AS cleared_balance
    FROM entries e
    JOIN transactions t ON t.id = e.transaction_id
    JOIN entry_clearings ec ON ec.entry_id = e.id
    WHERE t.date <= CURRENT_DATE
    GROUP BY e.account_id
)
SELECT
    h.id          AS account_id,
    h.full_name   AS account_name,
    h.name        AS leaf_name,
    h.type        AS account_type,
    a.subtype,
    h.parent_id,
    d_data.own_balance        AS own_balance,
    d_data.future_own_balance AS future_own_balance,
    (
        SELECT COALESCE(SUM(desc_data.own_balance), 0)
        FROM account_names_hierarchical d
        JOIN account_own_data desc_data ON d.id = desc_data.id
        WHERE d.full_name = h.full_name
           OR d.full_name LIKE h.full_name || ':%'
    ) AS balance,
    (
        SELECT COALESCE(SUM(desc_data.future_own_balance), 0)
        FROM account_names_hierarchical d
        JOIN account_own_data desc_data ON d.id = desc_data.id
        WHERE d.full_name = h.full_name
           OR d.full_name LIKE h.full_name || ':%'
    ) AS future_balance,
    (
        SELECT MAX(desc_data.own_last_entry_date)
        FROM account_names_hierarchical d
        JOIN account_own_data desc_data ON d.id = desc_data.id
        WHERE d.full_name = h.full_name
           OR d.full_name LIKE h.full_name || ':%'
    ) AS last_entry_date,
    h.icon,
    h.color,
    h.hidden,
    a.last_checked AS last_checked,
    rs.reconciled_through,
    COALESCE(c.cleared_balance, 0) AS cleared_balance
FROM account_names_hierarchical h
JOIN accounts a ON h.id = a.id
LEFT JOIN account_own_data d_data ON h.id = d_data.id
LEFT JOIN account_reconciliation_status rs ON rs.account_id = h.id
LEFT JOIN cleared c ON c.account_id = h.id;

GRANT SELECT ON account_balances TO authenticated;

-- transactions_with_entries: append clearing info for the Ledger's cleared glyph.
CREATE OR REPLACE VIEW transactions_with_entries AS
SELECT
    t.id,
    t.date,
    t.description,
    t.metadata,
    t.created_at,
    (
        SELECT array_agg(DISTINCT e.account_id)
        FROM entries e
        WHERE e.transaction_id = t.id
    ) AS account_ids,
    COALESCE(
        (
            SELECT jsonb_agg(jsonb_build_object(
                'id', e.id,
                'account_id', e.account_id,
                'account_name', a.name,
                'account_type', a.type,
                'amount', e.amount,
                'currency', e.currency,
                'exchange_rate', e.exchange_rate,
                'amount_base', e.amount_base
            ) ORDER BY e.created_at)
            FROM entries e
            JOIN accounts a ON e.account_id = a.id
            WHERE e.transaction_id = t.id
        ),
        '[]'::jsonb
    ) AS entries,
    (
        SELECT jsonb_build_object(
            'reconciliation_id', ec.reconciliation_id,
            'period_end', ec.period_end,
            'account_id', ec.account_id,
            'statement_ref', ec.statement_ref
        )
        FROM entries e
        JOIN entry_clearings ec ON ec.entry_id = e.id
        WHERE e.transaction_id = t.id
        ORDER BY ec.period_end DESC
        LIMIT 1
    ) AS clearing
FROM transactions t;

GRANT SELECT ON transactions_with_entries TO authenticated;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION open_reconciliation(
  p_account_id        UUID,
  p_period_start      DATE,
  p_period_end        DATE,
  p_statement_opening NUMERIC,
  p_statement_closing NUMERIC,
  p_currency          TEXT DEFAULT NULL,
  p_statement_ref     TEXT DEFAULT NULL,
  p_created_by        TEXT DEFAULT NULL
) RETURNS reconciliations AS $$
DECLARE
  v_row            reconciliations;
  v_ledger_opening NUMERIC;
  v_ledger_closing NUMERIC;
  v_prev           reconciliations;
  v_notes          TEXT := NULL;
BEGIN
  IF p_period_end < p_period_start THEN
    RAISE EXCEPTION 'period_end must be >= period_start';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = p_account_id AND type IN ('asset', 'liability')) THEN
    RAISE EXCEPTION 'Reconciliation requires an asset or liability account';
  END IF;

  v_ledger_opening := ledger_balance_as_of(p_account_id, p_period_start - 1);
  v_ledger_closing := ledger_balance_as_of(p_account_id, p_period_end);

  SELECT * INTO v_prev
  FROM reconciliations r
  WHERE r.account_id = p_account_id
    AND r.status IN ('balanced', 'adjusted')
    AND r.period_end < p_period_start
  ORDER BY r.period_end DESC, r.closed_at DESC
  LIMIT 1;

  IF FOUND AND p_statement_opening IS NOT NULL
     AND abs(v_prev.statement_closing - p_statement_opening) >= 0.005 THEN
    v_notes := format('continuity_break: previous reconciliation (%s → %s) closed at %s but this statement opens at %s',
                      v_prev.period_start, v_prev.period_end, v_prev.statement_closing, p_statement_opening);
  END IF;

  IF EXISTS (
    SELECT 1 FROM reconciliations r
    WHERE r.account_id = p_account_id AND r.status = 'open' AND r.period_end < p_period_start
      AND r.difference IS NOT NULL AND abs(r.difference) >= 0.005
  ) THEN
    v_notes := concat_ws(E'\n', v_notes, 'predecessor_open: an earlier period is still open with a non-zero difference');
  END IF;

  INSERT INTO reconciliations (
    account_id, period_start, period_end, currency, statement_opening, statement_closing,
    ledger_opening, ledger_closing, cleared_total, outstanding_total, difference,
    status, statement_ref, notes, created_by
  ) VALUES (
    p_account_id, p_period_start, p_period_end, p_currency, p_statement_opening, p_statement_closing,
    v_ledger_opening, v_ledger_closing, 0, 0, p_statement_closing - v_ledger_opening,
    'open', p_statement_ref, v_notes, p_created_by
  ) RETURNING * INTO v_row;

  RETURN v_row;
END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION open_reconciliation(UUID, DATE, DATE, NUMERIC, NUMERIC, TEXT, TEXT, TEXT) TO authenticated;

-- p_items: [{kind, entry_id?, statement_line_hash?, amount?, note?}]
-- cleared amounts default to the entry's amount_base.
CREATE OR REPLACE FUNCTION set_reconciliation_items(p_id UUID, p_items JSONB)
RETURNS reconciliations AS $$
DECLARE
  v_row  reconciliations;
  v_item JSONB;
BEGIN
  SELECT * INTO v_row FROM reconciliations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reconciliation % not found', p_id; END IF;
  IF v_row.status IN ('balanced', 'adjusted', 'abandoned') THEN
    RAISE EXCEPTION 'Reconciliation % is %, reopen it before changing items', p_id, v_row.status;
  END IF;

  DELETE FROM reconciliation_items WHERE reconciliation_id = p_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    INSERT INTO reconciliation_items (reconciliation_id, kind, entry_id, statement_line_hash, amount, note)
    VALUES (
      p_id,
      v_item->>'kind',
      NULLIF(v_item->>'entry_id', '')::uuid,
      v_item->>'statement_line_hash',
      COALESCE((v_item->>'amount')::numeric,
               (SELECT e.amount_base FROM entries e WHERE e.id = NULLIF(v_item->>'entry_id', '')::uuid)),
      v_item->>'note'
    );
  END LOOP;

  UPDATE reconciliations r
  SET cleared_total = COALESCE((SELECT SUM(amount) FROM reconciliation_items i WHERE i.reconciliation_id = p_id AND i.kind = 'cleared'), 0),
      outstanding_total = COALESCE((SELECT SUM(amount) FROM reconciliation_items i WHERE i.reconciliation_id = p_id AND i.kind = 'outstanding'), 0),
      ledger_closing = ledger_balance_as_of(r.account_id, r.period_end)
  WHERE r.id = p_id;

  UPDATE reconciliations r
  SET difference = r.statement_closing - (r.ledger_opening + r.cleared_total)
  WHERE r.id = p_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION set_reconciliation_items(UUID, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION close_reconciliation(
  p_id                        UUID,
  p_status                    TEXT,
  p_adjustment_transaction_id UUID DEFAULT NULL,
  p_notes                     TEXT DEFAULT NULL
) RETURNS reconciliations AS $$
DECLARE
  v_row         reconciliations;
  v_ajustes_id  UUID;
  v_account_leg NUMERIC;
  v_ajustes_leg NUMERIC;
BEGIN
  SELECT * INTO v_row FROM reconciliations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reconciliation % not found', p_id; END IF;

  IF p_status = 'balanced' THEN
    IF v_row.difference IS NULL OR abs(v_row.difference) >= 0.005 THEN
      RAISE EXCEPTION 'Cannot close as balanced: difference is %', v_row.difference;
    END IF;
  ELSIF p_status = 'adjusted' THEN
    IF p_adjustment_transaction_id IS NULL THEN
      RAISE EXCEPTION 'Closing as adjusted requires an adjustment transaction';
    END IF;
    SELECT id INTO v_ajustes_id FROM accounts WHERE parent_id IS NULL AND name = 'ajustes' LIMIT 1;
    IF v_ajustes_id IS NULL THEN
      RAISE EXCEPTION 'Suspense account "ajustes" is missing';
    END IF;
    SELECT SUM(e.amount_base) FILTER (WHERE e.account_id = v_row.account_id),
           SUM(e.amount_base) FILTER (WHERE e.account_id = v_ajustes_id)
    INTO v_account_leg, v_ajustes_leg
    FROM entries e WHERE e.transaction_id = p_adjustment_transaction_id;
    IF v_account_leg IS NULL OR v_ajustes_leg IS NULL THEN
      RAISE EXCEPTION 'Adjustment transaction must move value between the account and "ajustes"';
    END IF;
    IF abs(v_account_leg - v_row.difference) >= 0.005 THEN
      RAISE EXCEPTION 'Adjustment leg % does not equal the difference %', v_account_leg, v_row.difference;
    END IF;
    INSERT INTO reconciliation_items (reconciliation_id, kind, entry_id, amount, note)
    SELECT p_id, 'adjustment', e.id, e.amount_base, 'reconciliation adjustment'
    FROM entries e
    WHERE e.transaction_id = p_adjustment_transaction_id AND e.account_id = v_row.account_id
    ON CONFLICT DO NOTHING;
  ELSIF p_status = 'abandoned' THEN
    NULL;
  ELSIF p_status = 'open' THEN
    UPDATE reconciliations SET status = 'open', closed_at = NULL,
           notes = concat_ws(E'\n', notes, p_notes)
    WHERE id = p_id RETURNING * INTO v_row;
    RETURN v_row;
  ELSE
    RAISE EXCEPTION 'Unknown reconciliation status %', p_status;
  END IF;

  UPDATE reconciliations
  SET status = p_status,
      adjustment_transaction_id = COALESCE(p_adjustment_transaction_id, adjustment_transaction_id),
      notes = concat_ws(E'\n', notes, p_notes),
      closed_at = now()
  WHERE id = p_id
  RETURNING * INTO v_row;

  IF p_status IN ('balanced', 'adjusted') THEN
    UPDATE accounts SET last_checked = now() WHERE id = v_row.account_id;
  END IF;

  RETURN v_row;
END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION close_reconciliation(UUID, TEXT, UUID, TEXT) TO authenticated;

-- Reopen a closed period (used when a cleared entry is edited with the user's consent).
CREATE OR REPLACE FUNCTION reopen_reconciliation(p_id UUID, p_notes TEXT DEFAULT NULL)
RETURNS reconciliations AS $$
DECLARE v_row reconciliations;
BEGIN
  UPDATE reconciliations r
  SET status = 'open', closed_at = NULL,
      notes = concat_ws(E'\n', r.notes, COALESCE(p_notes, 'reopened')),
      ledger_closing = ledger_balance_as_of(r.account_id, r.period_end)
  WHERE r.id = p_id
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reconciliation % not found', p_id; END IF;
  UPDATE reconciliations r
  SET difference = r.statement_closing - (r.ledger_opening + r.cleared_total)
  WHERE r.id = p_id RETURNING * INTO v_row;
  RETURN v_row;
END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION reopen_reconciliation(UUID, TEXT) TO authenticated;

-- Entries on an account not vouched for by any statement (outstanding-item analysis).
CREATE OR REPLACE FUNCTION uncleared_entries(p_account_id UUID, p_through_date DATE DEFAULT CURRENT_DATE, p_from_date DATE DEFAULT NULL)
RETURNS TABLE (entry_id UUID, transaction_id UUID, date DATE, description TEXT, amount NUMERIC, currency TEXT, amount_base NUMERIC, metadata JSONB)
LANGUAGE sql STABLE AS $$
  SELECT e.id, t.id, t.date, t.description, e.amount, e.currency, e.amount_base, t.metadata
  FROM entries e
  JOIN transactions t ON t.id = e.transaction_id
  WHERE e.account_id = p_account_id
    AND t.date <= p_through_date
    AND (p_from_date IS NULL OR t.date >= p_from_date)
    AND NOT EXISTS (SELECT 1 FROM entry_clearings ec WHERE ec.entry_id = e.id)
  ORDER BY t.date, t.created_at;
$$;
GRANT EXECUTE ON FUNCTION uncleared_entries(UUID, DATE, DATE) TO authenticated;

NOTIFY pgrst, 'reload schema';
