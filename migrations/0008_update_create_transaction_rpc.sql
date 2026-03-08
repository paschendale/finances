-- RPC function to create a transaction with its entries
CREATE OR REPLACE FUNCTION create_transaction(
  date DATE,
  description TEXT,
  entries JSONB
) RETURNS JSONB AS $$
DECLARE
  v_transaction_id UUID;
  v_entry JSONB;
  v_total_amount_base NUMERIC := 0;
  v_entry_count INTEGER := 0;
  v_result JSONB;
  
  -- Variables for smart defaults
  v_category_id UUID;
  v_account_id UUID;
  v_currency TEXT;
BEGIN
  -- 1. Insert transaction
  INSERT INTO transactions (date, description)
  VALUES (date, description)
  RETURNING id INTO v_transaction_id;

  -- 2. Insert entries
  FOR v_entry IN SELECT * FROM jsonb_array_elements(entries)
  LOOP
    INSERT INTO entries (
      transaction_id,
      account_id,
      amount,
      currency,
      exchange_rate,
      amount_base
    ) VALUES (
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

  -- 3. Validate entry count
  IF v_entry_count < 2 THEN
    RAISE EXCEPTION 'Transaction must have at least two entries';
  END IF;

  -- 4. Validate balance (SUM(amount_base) = 0)
  IF v_total_amount_base <> 0 THEN
    RAISE EXCEPTION 'Transaction is not balanced: SUM(amount_base) = %', v_total_amount_base;
  END IF;

  -- 5. Update smart defaults
  
  -- Heuristic to find primary accounts
  -- Category: First expense or income account
  SELECT e.account_id INTO v_category_id
  FROM entries e
  JOIN accounts a ON e.account_id = a.id
  WHERE e.transaction_id = v_transaction_id
    AND a.type IN ('expense', 'income')
  LIMIT 1;
  
  -- Account: First asset, liability or equity account
  SELECT e.account_id, e.currency INTO v_account_id, v_currency
  FROM entries e
  JOIN accounts a ON e.account_id = a.id
  WHERE e.transaction_id = v_transaction_id
    AND a.type IN ('asset', 'liability', 'equity')
  LIMIT 1;

  -- If no expense/income found (likely a transfer), use positive entry as category
  IF v_category_id IS NULL THEN
      SELECT e.account_id INTO v_category_id
      FROM entries e
      WHERE e.transaction_id = v_transaction_id AND e.amount > 0
      LIMIT 1;
  END IF;
  
  -- If no asset/liability found, use negative entry as account
  IF v_account_id IS NULL THEN
      SELECT e.account_id INTO v_account_id
      FROM entries e
      WHERE e.transaction_id = v_transaction_id AND e.amount < 0
      LIMIT 1;
  END IF;

  -- If we have both, update the description-based memory
  IF v_category_id IS NOT NULL AND v_account_id IS NOT NULL THEN
      INSERT INTO description_memories (description, category_id, account_id, currency, updated_at)
      VALUES (description, v_category_id, v_account_id, v_currency, now())
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

  -- 6. Construct return object
  SELECT jsonb_build_object(
    'id', t.id,
    'date', t.date,
    'description', t.description,
    'entries', (
      SELECT jsonb_agg(e.*)
      FROM entries e
      WHERE e.transaction_id = t.id
    )
  ) INTO v_result
  FROM transactions t
  WHERE t.id = v_transaction_id;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;
