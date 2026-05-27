-- Migration 0046: RPC for plan-independent category monthly spending history

CREATE OR REPLACE FUNCTION get_category_monthly_history(
  p_account_id UUID,
  p_months     INTEGER DEFAULT 13
)
RETURNS TABLE(month DATE, spent NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH months AS (
    SELECT date_trunc('month', gs)::date AS month
    FROM generate_series(
      date_trunc('month', CURRENT_DATE - ((p_months - 1) || ' months')::interval),
      date_trunc('month', CURRENT_DATE),
      '1 month'::interval
    ) AS gs
  ),
  account_full AS (
    SELECT full_name FROM account_names_hierarchical WHERE id = p_account_id
  ),
  monthly_spending AS (
    SELECT
      date_trunc('month', t.date)::date AS month,
      SUM(e.amount_base)                AS spent
    FROM entries e
    JOIN transactions t               ON e.transaction_id = t.id
    JOIN account_names_hierarchical dh ON e.account_id    = dh.id
    CROSS JOIN account_full af
    WHERE dh.full_name = af.full_name
       OR dh.full_name LIKE af.full_name || ':%'
    GROUP BY date_trunc('month', t.date)::date
  )
  SELECT m.month, COALESCE(ms.spent, 0) AS spent
  FROM months m
  LEFT JOIN monthly_spending ms ON ms.month = m.month
  ORDER BY m.month;
$$;

GRANT EXECUTE ON FUNCTION get_category_monthly_history(UUID, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
