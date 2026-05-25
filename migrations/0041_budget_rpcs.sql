-- Migration 0041: Budget RPC functions

CREATE OR REPLACE FUNCTION create_budget_plan(
    p_name         TEXT,
    p_period_start DATE,
    p_period_end   DATE
) RETURNS budget_plans AS $$
DECLARE
    v_plan budget_plans;
BEGIN
    UPDATE budget_plans SET is_current = FALSE;
    INSERT INTO budget_plans (name, period_start, period_end, is_current)
    VALUES (p_name, p_period_start, p_period_end, TRUE)
    RETURNING * INTO v_plan;
    RETURN v_plan;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION set_current_budget_plan(
    p_plan_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
    UPDATE budget_plans SET is_current = FALSE;
    UPDATE budget_plans SET is_current = TRUE WHERE id = p_plan_id;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION upsert_budget_item(
    p_plan_id       UUID,
    p_account_id    UUID,
    p_period_amount NUMERIC,
    p_min_pct       NUMERIC,
    p_max_pct       NUMERIC
) RETURNS budget_items AS $$
DECLARE
    v_account_type TEXT;
    v_item         budget_items;
BEGIN
    SELECT type INTO v_account_type FROM accounts WHERE id = p_account_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Account not found: %', p_account_id;
    END IF;
    IF v_account_type <> 'expense' THEN
        RAISE EXCEPTION 'Account must be of type expense, got: %', v_account_type;
    END IF;

    INSERT INTO budget_items (plan_id, account_id, period_amount, min_pct, max_pct)
    VALUES (p_plan_id, p_account_id, p_period_amount, p_min_pct, p_max_pct)
    ON CONFLICT (plan_id, account_id) DO UPDATE
        SET period_amount = EXCLUDED.period_amount,
            min_pct       = EXCLUDED.min_pct,
            max_pct       = EXCLUDED.max_pct
    RETURNING * INTO v_item;

    RETURN v_item;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION delete_budget_item(
    p_id UUID
) RETURNS BOOLEAN AS $$
BEGIN
    DELETE FROM budget_items WHERE id = p_id;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION create_budget_plan(TEXT, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION set_current_budget_plan(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION upsert_budget_item(UUID, UUID, NUMERIC, NUMERIC, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION delete_budget_item(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
