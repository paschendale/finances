-- Migration 0047: transaction provenance
--
-- create_transaction / update_transaction gain an optional p_metadata JSONB argument so
-- callers (the advisor applier) can record where a transaction came from: source, plan,
-- statement, FITID and the raw statement line. Three-argument callers keep working.
-- Indexes make dedup by FITID and filtering by source cheap.
--
-- The function bodies are those of 0023 / 0015 with `metadata` added; 0050 replaces the
-- description-memory block with merchant-alias learning.

DROP FUNCTION IF EXISTS create_transaction(DATE, TEXT, JSONB);

CREATE OR REPLACE FUNCTION create_transaction(
  p_date DATE,
  p_description TEXT,
  p_entries JSONB,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB AS $$
DECLARE
  v_transaction_id UUID;
  v_entry JSONB;
  v_total_amount_base NUMERIC := 0;
  v_entry_count INTEGER := 0;
  v_result JSONB;
  v_category_id UUID;
  v_account_id UUID;
  v_currency TEXT;
BEGIN
  INSERT INTO transactions (date, description, metadata)
  VALUES (p_date, p_description, COALESCE(p_metadata, '{}'::jsonb))
  RETURNING id INTO v_transaction_id;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
  LOOP
    INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base)
    VALUES (
      v_transaction_id,
      (v_entry->>'account_id')::UUID,
      (v_entry->>'amount')::NUMERIC,
      (v_entry->>'currency')::TEXT,
      COALESCE((v_entry->>'exchange_rate')::NUMERIC, 1.0),
      (v_entry->>'amount_base')::NUMERIC
    );
    v_total_amount_base := v_total_amount_base + (v_entry->>'amount_base')::NUMERIC;
    v_entry_count := v_entry_count + 1;
  END LOOP;

  IF v_entry_count < 2 THEN
    RAISE EXCEPTION 'Transaction must have at least two entries';
  END IF;
  IF v_total_amount_base <> 0 THEN
    RAISE EXCEPTION 'Transaction is not balanced: SUM(amount_base) = %', v_total_amount_base;
  END IF;

  SELECT e.account_id INTO v_category_id
  FROM entries e JOIN accounts a ON e.account_id = a.id
  WHERE e.transaction_id = v_transaction_id AND a.type IN ('expense', 'income')
  LIMIT 1;
  IF v_category_id IS NULL THEN
    SELECT e.account_id INTO v_category_id
    FROM entries e WHERE e.transaction_id = v_transaction_id AND e.amount > 0 LIMIT 1;
  END IF;

  SELECT e.account_id, e.currency INTO v_account_id, v_currency
  FROM entries e JOIN accounts a ON e.account_id = a.id
  WHERE e.transaction_id = v_transaction_id
    AND a.type IN ('asset', 'liability', 'equity')
    AND e.account_id != COALESCE(v_category_id, '00000000-0000-0000-0000-000000000000'::UUID)
  ORDER BY (e.amount < 0) DESC
  LIMIT 1;
  IF v_account_id IS NULL THEN
    SELECT e.account_id, e.currency INTO v_account_id, v_currency
    FROM entries e
    WHERE e.transaction_id = v_transaction_id AND e.amount < 0
      AND e.account_id != COALESCE(v_category_id, '00000000-0000-0000-0000-000000000000'::UUID)
    LIMIT 1;
  END IF;

  IF v_category_id IS NOT NULL AND v_account_id IS NOT NULL THEN
    INSERT INTO description_memories (description, category_id, account_id, currency, updated_at, usage_count, last_used_at)
    VALUES (p_description, v_category_id, v_account_id, v_currency, now(), 1, now())
    ON CONFLICT (description) DO UPDATE SET
      category_id = EXCLUDED.category_id,
      account_id = EXCLUDED.account_id,
      currency = EXCLUDED.currency,
      updated_at = now(),
      usage_count = description_memories.usage_count + 1,
      last_used_at = now();
  END IF;

  IF v_account_id IS NOT NULL THEN
    INSERT INTO global_settings (key, value, updated_at)
    VALUES ('last_used_account_id', v_account_id::TEXT, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;
  IF v_currency IS NOT NULL THEN
    INSERT INTO global_settings (key, value, updated_at)
    VALUES ('last_used_currency', v_currency, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;

  SELECT jsonb_build_object(
    'id', t.id,
    'date', t.date,
    'description', t.description,
    'metadata', t.metadata,
    'entries', (SELECT jsonb_agg(e.*) FROM entries e WHERE e.transaction_id = t.id)
  ) INTO v_result
  FROM transactions t WHERE t.id = v_transaction_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION create_transaction(DATE, TEXT, JSONB, JSONB) TO authenticated;

DROP FUNCTION IF EXISTS update_transaction(UUID, DATE, TEXT, JSONB);

CREATE OR REPLACE FUNCTION update_transaction(
  p_id UUID,
  p_date DATE,
  p_description TEXT,
  p_entries JSONB,
  p_metadata JSONB DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_entry JSONB;
  v_total_amount_base NUMERIC := 0;
  v_entry_count INTEGER := 0;
  v_result JSONB;
  v_category_id UUID;
  v_account_id UUID;
  v_currency TEXT;
BEGIN
  -- NULL metadata keeps the stored value; a JSON object merges over it so provenance
  -- written by one caller survives edits made by another.
  UPDATE transactions
  SET date = p_date,
      description = p_description,
      metadata = CASE WHEN p_metadata IS NULL THEN metadata ELSE COALESCE(metadata, '{}'::jsonb) || p_metadata END,
      updated_at = now()
  WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction with ID % not found', p_id;
  END IF;

  DELETE FROM entries WHERE transaction_id = p_id;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
  LOOP
    INSERT INTO entries (transaction_id, account_id, amount, currency, exchange_rate, amount_base)
    VALUES (
      p_id,
      (v_entry->>'account_id')::UUID,
      (v_entry->>'amount')::NUMERIC,
      (v_entry->>'currency')::TEXT,
      COALESCE((v_entry->>'exchange_rate')::NUMERIC, 1.0),
      (v_entry->>'amount_base')::NUMERIC
    );
    v_total_amount_base := v_total_amount_base + (v_entry->>'amount_base')::NUMERIC;
    v_entry_count := v_entry_count + 1;
  END LOOP;

  IF v_entry_count < 2 THEN
    RAISE EXCEPTION 'Transaction must have at least two entries';
  END IF;
  IF v_total_amount_base <> 0 THEN
    RAISE EXCEPTION 'Transaction is not balanced: SUM(amount_base) = %', v_total_amount_base;
  END IF;

  SELECT e.account_id INTO v_category_id
  FROM entries e JOIN accounts a ON e.account_id = a.id
  WHERE e.transaction_id = p_id AND a.type IN ('expense', 'income')
  LIMIT 1;
  IF v_category_id IS NULL THEN
    SELECT e.account_id INTO v_category_id
    FROM entries e WHERE e.transaction_id = p_id AND e.amount > 0 LIMIT 1;
  END IF;

  SELECT e.account_id, e.currency INTO v_account_id, v_currency
  FROM entries e JOIN accounts a ON e.account_id = a.id
  WHERE e.transaction_id = p_id
    AND a.type IN ('asset', 'liability', 'equity')
    AND e.account_id != COALESCE(v_category_id, '00000000-0000-0000-0000-000000000000'::UUID)
  ORDER BY (e.amount < 0) DESC
  LIMIT 1;
  IF v_account_id IS NULL THEN
    SELECT e.account_id, e.currency INTO v_account_id, v_currency
    FROM entries e
    WHERE e.transaction_id = p_id AND e.amount < 0
      AND e.account_id != COALESCE(v_category_id, '00000000-0000-0000-0000-000000000000'::UUID)
    LIMIT 1;
  END IF;

  IF v_category_id IS NOT NULL AND v_account_id IS NOT NULL THEN
    INSERT INTO description_memories (description, category_id, account_id, currency, updated_at, usage_count, last_used_at)
    VALUES (p_description, v_category_id, v_account_id, v_currency, now(), 1, now())
    ON CONFLICT (description) DO UPDATE SET
      category_id = EXCLUDED.category_id,
      account_id = EXCLUDED.account_id,
      currency = EXCLUDED.currency,
      updated_at = now(),
      usage_count = description_memories.usage_count + 1,
      last_used_at = now();
  END IF;

  IF v_account_id IS NOT NULL THEN
    INSERT INTO global_settings (key, value, updated_at)
    VALUES ('last_used_account_id', v_account_id::TEXT, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;
  IF v_currency IS NOT NULL THEN
    INSERT INTO global_settings (key, value, updated_at)
    VALUES ('last_used_currency', v_currency, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;

  SELECT jsonb_build_object(
    'id', t.id,
    'date', t.date,
    'description', t.description,
    'metadata', t.metadata,
    'entries', (
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id,
        'account_id', e.account_id,
        'account_name', a.full_name,
        'account_type', a.type,
        'amount', e.amount,
        'currency', e.currency,
        'exchange_rate', e.exchange_rate,
        'amount_base', e.amount_base,
        'created_at', e.created_at
      ) ORDER BY e.created_at DESC)
      FROM entries e
      JOIN account_names_hierarchical a ON e.account_id = a.id
      WHERE e.transaction_id = t.id
    )
  ) INTO v_result
  FROM transactions t WHERE t.id = p_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION update_transaction(UUID, DATE, TEXT, JSONB, JSONB) TO authenticated;

CREATE INDEX IF NOT EXISTS idx_transactions_metadata_fitid
  ON transactions ((metadata->>'fitid')) WHERE metadata ? 'fitid';
CREATE INDEX IF NOT EXISTS idx_transactions_metadata_source
  ON transactions ((metadata->>'source'));

NOTIFY pgrst, 'reload schema';
