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

  -- 5. Construct return object
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
