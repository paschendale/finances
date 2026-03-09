-- 0028_backfill_memories.sql
-- Backfill description_memories from existing transactions

DO $$
DECLARE
    v_rec RECORD;
    v_category_id UUID;
    v_account_id UUID;
    v_currency TEXT;
BEGIN
    FOR v_rec IN 
        SELECT description, id, date 
        FROM transactions 
        WHERE description NOT IN (SELECT description FROM description_memories)
        ORDER BY date DESC
    LOOP
        -- Heuristic to find primary accounts (similar to create_transaction logic)
        
        -- Category (Destination): First expense or income account, else the positive entry
        SELECT e.account_id INTO v_category_id
        FROM entries e
        JOIN accounts a ON e.account_id = a.id
        WHERE e.transaction_id = v_rec.id
          AND a.type IN ('expense', 'income')
        LIMIT 1;
        
        IF v_category_id IS NULL THEN
            SELECT e.account_id INTO v_category_id
            FROM entries e
            WHERE e.transaction_id = v_rec.id AND e.amount > 0
            LIMIT 1;
        END IF;

        -- Account (Source): First asset/liability account that is NOT the category, else the negative entry
        SELECT e.account_id, e.currency INTO v_account_id, v_currency
        FROM entries e
        JOIN accounts a ON e.account_id = a.id
        WHERE e.transaction_id = v_rec.id
          AND a.type IN ('asset', 'liability', 'equity')
          AND e.account_id != COALESCE(v_category_id, '00000000-0000-0000-0000-000000000000'::UUID)
        ORDER BY (e.amount < 0) DESC -- Prefer negative (source) account
        LIMIT 1;
        
        IF v_account_id IS NULL THEN
            SELECT e.account_id, e.currency INTO v_account_id, v_currency
            FROM entries e
            WHERE e.transaction_id = v_rec.id 
              AND e.amount < 0
              AND e.account_id != COALESCE(v_category_id, '00000000-0000-0000-0000-000000000000'::UUID)
            LIMIT 1;
        END IF;

        -- If we found both, insert into memories
        IF v_category_id IS NOT NULL AND v_account_id IS NOT NULL THEN
            INSERT INTO description_memories (description, category_id, account_id, currency, updated_at, usage_count, last_used_at)
            VALUES (v_rec.description, v_category_id, v_account_id, v_currency, now(), 1, now())
            ON CONFLICT (description) DO NOTHING;
        END IF;
    END LOOP;
END $$;
