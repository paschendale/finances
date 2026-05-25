-- Migration 0040: Budget views

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
    bi.max_pct
FROM budget_items bi
JOIN account_names_hierarchical h ON bi.account_id = h.id
JOIN accounts a ON bi.account_id = a.id;

CREATE OR REPLACE VIEW budget_monthly_spending AS
WITH plan_months AS (
    SELECT
        bp.id AS plan_id,
        date_trunc('month', gs)::date AS month
    FROM budget_plans bp
    CROSS JOIN generate_series(bp.period_start, bp.period_end, '1 month'::interval) AS gs
),
monthly_spending AS (
    SELECT
        bi.plan_id,
        bi.account_id AS budget_account_id,
        date_trunc('month', t.date)::date AS month,
        SUM(e.amount_base) AS spent
    FROM budget_items bi
    JOIN account_names_hierarchical bh ON bh.id = bi.account_id
    JOIN account_names_hierarchical dh ON dh.full_name = bh.full_name
                                       OR dh.full_name LIKE bh.full_name || ':%'
    JOIN entries e ON e.account_id = dh.id
    JOIN transactions t ON e.transaction_id = t.id
    GROUP BY bi.plan_id, bi.account_id, date_trunc('month', t.date)::date
)
SELECT
    pm.plan_id,
    bi.account_id,
    pm.month,
    COALESCE(ms.spent, 0) AS spent
FROM plan_months pm
JOIN budget_items bi ON bi.plan_id = pm.plan_id
LEFT JOIN monthly_spending ms ON ms.plan_id      = pm.plan_id
                              AND ms.budget_account_id = bi.account_id
                              AND ms.month        = pm.month;

NOTIFY pgrst, 'reload schema';
