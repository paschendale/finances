-- Migration 0044: Add category_type to budget_items (monthly vs yearly adjustment)

ALTER TABLE budget_items
  ADD COLUMN IF NOT EXISTS category_type TEXT NOT NULL DEFAULT 'yearly';

-- Add check constraint (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'budget_items_category_type_check'
      AND conrelid = 'budget_items'::regclass
  ) THEN
    ALTER TABLE budget_items
      ADD CONSTRAINT budget_items_category_type_check
        CHECK (category_type IN ('yearly', 'monthly'));
  END IF;
END;
$$;

-- Rebuild view to expose category_type
CREATE OR REPLACE VIEW budget_items_with_accounts AS
SELECT
    bi.id,
    bi.plan_id,
    bi.account_id,
    h.full_name  AS account_full_name,
    h.name       AS account_name,
    a.icon,
    a.color,
    h.parent_id,
    bi.period_amount,
    bi.min_pct,
    bi.max_pct,
    bi.sort_order,
    bi.category_type
FROM budget_items bi
JOIN account_names_hierarchical h ON bi.account_id = h.id
JOIN accounts a ON bi.account_id = a.id;

-- Update upsert RPC to accept category_type
CREATE OR REPLACE FUNCTION upsert_budget_item(
    p_plan_id       UUID,
    p_account_id    UUID,
    p_period_amount NUMERIC,
    p_min_pct       NUMERIC,
    p_max_pct       NUMERIC,
    p_sort_order    INTEGER DEFAULT 0,
    p_category_type TEXT DEFAULT 'yearly'
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
    IF p_category_type NOT IN ('yearly', 'monthly') THEN
        RAISE EXCEPTION 'category_type must be yearly or monthly, got: %', p_category_type;
    END IF;

    INSERT INTO budget_items (plan_id, account_id, period_amount, min_pct, max_pct, sort_order, category_type)
    VALUES (p_plan_id, p_account_id, p_period_amount, p_min_pct, p_max_pct, p_sort_order, p_category_type)
    ON CONFLICT (plan_id, account_id) DO UPDATE
        SET period_amount  = EXCLUDED.period_amount,
            min_pct        = EXCLUDED.min_pct,
            max_pct        = EXCLUDED.max_pct,
            sort_order     = EXCLUDED.sort_order,
            category_type  = EXCLUDED.category_type
    RETURNING * INTO v_item;

    RETURN v_item;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION upsert_budget_item(UUID, UUID, NUMERIC, NUMERIC, NUMERIC, INTEGER, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
