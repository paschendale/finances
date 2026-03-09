-- Daily balances for all account types and subtypes
CREATE OR REPLACE VIEW daily_balances AS
WITH dates AS (
    SELECT generate_series(
        COALESCE((SELECT MIN(date) FROM transactions), CURRENT_DATE),
        CURRENT_DATE,
        '1 day'::interval
    )::date AS date
),
categories AS (
    SELECT 'asset' as type UNION ALL
    SELECT 'liability' as type UNION ALL
    SELECT 'expense' as type UNION ALL
    SELECT 'income' as type UNION ALL
    SELECT 'equity' as type UNION ALL
    SELECT 'checking' as type UNION ALL
    SELECT 'emergency' as type UNION ALL
    SELECT 'investments' as type UNION ALL
    SELECT 'credit-card' as type
),
grid AS (
    SELECT d.date, c.type
    FROM dates d, categories c
),
daily_changes AS (
    SELECT 
        t.date,
        a.type AS account_type,
        an.full_name,
        SUM(e.amount_base) AS change
    FROM transactions t
    JOIN entries e ON t.id = e.transaction_id
    JOIN accounts a ON e.account_id = a.id
    JOIN account_names_hierarchical an ON a.id = an.id
    GROUP BY 1, 2, 3
),
daily_category_changes AS (
    -- Original types
    SELECT date, account_type as type, SUM(change) as change FROM daily_changes GROUP BY 1, 2
    UNION ALL
    -- Subtypes based on full_name patterns
    SELECT 
        date, 
        CASE 
            WHEN full_name LIKE 'assets:checking:%' THEN 'checking'
            WHEN full_name LIKE 'assets:emergency:%' THEN 'emergency'
            WHEN full_name LIKE 'assets:investments:%' THEN 'investments'
            WHEN full_name LIKE 'liabilities:credit-card:%' THEN 'credit-card'
            ELSE 'other'
        END as type,
        SUM(change) as change
    FROM daily_changes
    GROUP BY 1, 2
),
balances AS (
    SELECT 
        g.date,
        g.type as account_type,
        SUM(COALESCE(dc.change, 0)) OVER (PARTITION BY g.type ORDER BY g.date) AS balance
    FROM grid g
    LEFT JOIN daily_category_changes dc ON g.date = dc.date AND g.type = dc.type
)
SELECT date, account_type::text, balance FROM balances
WHERE account_type != 'other'
UNION ALL
SELECT 
    date,
    'net_worth'::text as account_type,
    SUM(CASE WHEN account_type IN ('asset', 'liability', 'equity') THEN balance ELSE 0 END) as balance
FROM balances
WHERE account_type IN ('asset', 'liability', 'equity')
GROUP BY date;
