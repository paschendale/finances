-- RPC function to update a transaction and its entries
CREATE OR REPLACE FUNCTION update_transaction(
  p_id UUID,
  p_date DATE,
  p_description TEXT,
  p_entries JSONB
) RETURNS JSONB AS $$
DECLARE
  v_entry JSONB;
  v_total_amount_base NUMERIC := 0;
  v_entry_count INTEGER := 0;
  v_result JSONB;
  
  -- Variables for smart defaults
  v_category_id UUID;
  v_account_id UUID;
  v_currency TEXT;
BEGIN
  -- 1. Update transaction
  UPDATE transactions
  SET date = p_date,
      description = p_description,
      updated_at = now()
  WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction with ID % not found', p_id;
  END IF;

  -- 2. Delete existing entries
  DELETE FROM entries WHERE transaction_id = p_id;

  -- 3. Insert new entries
  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries)
  LOOP
    INSERT INTO entries (
      transaction_id,
      account_id,
      amount,
      currency,
      exchange_rate,
      amount_base
    ) VALUES (
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

  -- 4. Validate entry count
  IF v_entry_count < 2 THEN
    RAISE EXCEPTION 'Transaction must have at least two entries';
  END IF;

  -- 5. Validate balance (SUM(amount_base) = 0)
  -- Use a small epsilon for floating point comparison if needed, 
  -- but NUMERIC should be exact.
  IF v_total_amount_base <> 0 THEN
    RAISE EXCEPTION 'Transaction is not balanced: SUM(amount_base) = %', v_total_amount_base;
  END IF;

  -- 6. Update smart defaults (Same logic as create_transaction)
  
  -- Heuristic to find primary accounts
  -- Category (Destination): First expense or income account, else the positive entry
  SELECT e.account_id INTO v_category_id
  FROM entries e
  JOIN accounts a ON e.account_id = a.id
  WHERE e.transaction_id = p_id
    AND a.type IN ('expense', 'income')
  LIMIT 1;
  
  IF v_category_id IS NULL THEN
      SELECT e.account_id INTO v_category_id
      FROM entries e
      WHERE e.transaction_id = p_id AND e.amount > 0
      LIMIT 1;
  END IF;

  -- Account (Source): First asset/liability account that is NOT the category, else the negative entry
  SELECT e.account_id, e.currency INTO v_account_id, v_currency
  FROM entries e
  JOIN accounts a ON e.account_id = a.id
  WHERE e.transaction_id = p_id
    AND a.type IN ('asset', 'liability', 'equity')
    AND e.account_id != COALESCE(v_category_id, '00000000-0000-0000-0000-000000000000'::UUID)
  ORDER BY (e.amount < 0) DESC -- Prefer negative (source) account
  LIMIT 1;
  
  IF v_account_id IS NULL THEN
      SELECT e.account_id, e.currency INTO v_account_id, v_currency
      FROM entries e
      WHERE e.transaction_id = p_id 
        AND e.amount < 0
        AND e.account_id != COALESCE(v_category_id, '00000000-0000-0000-0000-000000000000'::UUID)
      LIMIT 1;
  END IF;

  -- If we have both, update the description-based memory
  IF v_category_id IS NOT NULL AND v_account_id IS NOT NULL THEN
      INSERT INTO description_memories (description, category_id, account_id, currency, updated_at)
      VALUES (p_description, v_category_id, v_account_id, v_currency, now())
      ON CONFLICT (description) DO UPDATE SET
          category_id = EXCLUDED.category_id,
          account_id = EXCLUDED.account_id,
          currency = EXCLUDED.currency,
          updated_at = now();
  END IF;

  -- Update global settings for last used account and currency
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

  -- 7. Construct return object
  SELECT jsonb_build_object(
    'id', t.id,
    'date', t.date,
    'description', t.description,
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
  FROM transactions t
  WHERE t.id = p_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;
