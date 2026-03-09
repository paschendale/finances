-- Daily balances for all account types
CREATE OR REPLACE VIEW daily_balances AS
WITH dates AS (
    SELECT generate_series(
        COALESCE((SELECT MIN(date) FROM transactions), CURRENT_DATE),
        CURRENT_DATE,
        '1 day'::interval
    )::date AS date
),
account_types AS (
    SELECT 'asset' as type UNION ALL
    SELECT 'liability' as type UNION ALL
    SELECT 'expense' as type UNION ALL
    SELECT 'income' as type UNION ALL
    SELECT 'equity' as type
),
grid AS (
    SELECT d.date, t.type
    FROM dates d, account_types t
),
daily_changes AS (
    SELECT 
        t.date,
        a.type AS account_type,
        SUM(e.amount_base) AS change
    FROM transactions t
    JOIN entries e ON t.id = e.transaction_id
    JOIN accounts a ON e.account_id = a.id
    GROUP BY 1, 2
),
balances AS (
    SELECT 
        g.date,
        g.type AS account_type,
        SUM(COALESCE(dc.change, 0)) OVER (PARTITION BY g.type ORDER BY g.date) AS balance
    FROM grid g
    LEFT JOIN daily_changes dc ON g.date = dc.date AND g.type = dc.account_type
)
SELECT date, account_type::text, balance FROM balances
UNION ALL
SELECT 
    date,
    'net_worth'::text as account_type,
    SUM(CASE WHEN account_type IN ('asset', 'liability', 'equity') THEN balance ELSE 0 END) as balance
FROM balances
GROUP BY date;
