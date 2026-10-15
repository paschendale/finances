-- Migration 0056: the opening balance of a reconciliation follows the bank, not the calendar
--
-- Card bills and hand-entered purchases do not share dates: a purchase entered on 30/05 is vouched by
-- the June bill. Opening a period at the ledger balance "as of the day before" then counts such
-- entries in the wrong period and no bill ever balances. The opening used in the equation
-- (`ledger_opening`, name kept) is now, in order: the statement closing of the previous reconciliation
-- of the account whose period ends where this one starts (continuity), else the statement's own
-- opening balance when the file carries one, else the ledger balance as of the day before.
-- `difference = statement_closing − (opening + Σ cleared)` is unchanged; cleared items may now sit
-- outside the period (they are vouched by this statement's lines).

BEGIN;

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
  v_adjacent       reconciliations;
  v_notes          TEXT := NULL;
BEGIN
  IF p_period_end < p_period_start THEN
    RAISE EXCEPTION 'period_end must be >= period_start';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = p_account_id AND type IN ('asset', 'liability')) THEN
    RAISE EXCEPTION 'Reconciliation requires an asset or liability account';
  END IF;

  v_ledger_closing := ledger_balance_as_of(p_account_id, p_period_end);

  -- The period that ends where this one starts (bills overlap by a day: May 01–Jun 01, Jun 01–Jul 01).
  SELECT * INTO v_adjacent
  FROM reconciliations r
  WHERE r.account_id = p_account_id
    AND r.status <> 'abandoned'
    AND r.period_end BETWEEN p_period_start - 1 AND p_period_start
  ORDER BY r.period_end DESC, r.created_at DESC
  LIMIT 1;

  v_ledger_opening := COALESCE(v_adjacent.statement_closing, p_statement_opening, ledger_balance_as_of(p_account_id, p_period_start - 1));

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

NOTIFY pgrst, 'reload schema';

COMMIT;
