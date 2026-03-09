-- Monthly balances for all account types
CREATE OR REPLACE VIEW monthly_balances AS
WITH RECURSIVE months AS (
    SELECT date_trunc('month', MIN(date))::date AS month
    FROM transactions
    UNION ALL
    SELECT (month + interval '1 month')::date
    FROM months
    WHERE month < date_trunc('month', CURRENT_DATE)::date
),
account_types AS (
    SELECT 'asset' as type UNION ALL
    SELECT 'liability' as type UNION ALL
    SELECT 'expense' as type UNION ALL
    SELECT 'income' as type UNION ALL
    SELECT 'equity' as type
),
grid AS (
    SELECT m.month, t.type
    FROM months m, account_types t
),
monthly_changes AS (
    SELECT 
        date_trunc('month', t.date)::date AS month,
        a.type AS account_type,
        SUM(e.amount_base) AS change
    FROM transactions t
    JOIN entries e ON t.id = e.transaction_id
    JOIN accounts a ON e.account_id = a.id
    GROUP BY 1, 2
),
balances AS (
    SELECT 
        g.month,
        g.type AS account_type,
        SUM(COALESCE(mc.change, 0)) OVER (PARTITION BY g.type ORDER BY g.month) AS balance
    FROM grid g
    LEFT JOIN monthly_changes mc ON g.month = mc.month AND g.type = mc.account_type
)
SELECT month, account_type::text, balance FROM balances
UNION ALL
SELECT 
    month,
    'net_worth'::text as account_type,
    SUM(CASE WHEN account_type IN ('asset', 'liability', 'equity') THEN balance ELSE 0 END) as balance
FROM balances
GROUP BY month;
