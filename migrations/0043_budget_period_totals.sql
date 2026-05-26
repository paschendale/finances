-- Migration 0043: budget_period_totals view for "Others" unbudgeted spending

CREATE OR REPLACE VIEW budget_period_totals AS
SELECT
    bp.id                                    AS plan_id,
    date_trunc('month', t.date)::date        AS month,
    SUM(e.amount_base)                       AS total_spent
FROM budget_plans bp
JOIN transactions t  ON t.date BETWEEN bp.period_start AND bp.period_end
JOIN entries e       ON e.transaction_id = t.id
JOIN accounts a      ON a.id = e.account_id
WHERE a.type = 'expense'
GROUP BY bp.id, date_trunc('month', t.date)::date;

GRANT SELECT ON budget_period_totals TO authenticated;

NOTIFY pgrst, 'reload schema';
