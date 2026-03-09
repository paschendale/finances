-- Update transactions_with_entries to include account_ids for efficient filtering
DROP VIEW IF EXISTS transactions_with_entries;
CREATE OR REPLACE VIEW transactions_with_entries AS
SELECT 
    t.id,
    t.date,
    t.description,
    t.metadata,
    t.created_at,
    (
        SELECT array_agg(DISTINCT e.account_id)
        FROM entries e
        WHERE e.transaction_id = t.id
    ) AS account_ids,
    COALESCE(
        (
            SELECT jsonb_agg(jsonb_build_object(
                'id', e.id,
                'account_id', e.account_id,
                'account_name', a.name,
                'account_type', a.type,
                'amount', e.amount,
                'currency', e.currency,
                'exchange_rate', e.exchange_rate,
                'amount_base', e.amount_base
            ) ORDER BY e.created_at)
            FROM entries e
            JOIN accounts a ON e.account_id = a.id
            WHERE e.transaction_id = t.id
        ),
        '[]'::jsonb
    ) AS entries
FROM transactions t;

-- Daily balances for every individual account
CREATE OR REPLACE VIEW daily_account_balances AS
WITH dates AS (
    SELECT generate_series(
        COALESCE((SELECT MIN(date) FROM transactions), CURRENT_DATE),
        CURRENT_DATE,
        '1 day'::interval
    )::date AS date
),
grid AS (
    SELECT d.date, a.id AS account_id
    FROM dates d, accounts a
),
daily_changes AS (
    SELECT 
        t.date,
        e.account_id,
        SUM(e.amount_base) AS change
    FROM transactions t
    JOIN entries e ON t.id = e.transaction_id
    GROUP BY 1, 2
),
balances AS (
    SELECT 
        g.date,
        g.account_id,
        SUM(COALESCE(dc.change, 0)) OVER (PARTITION BY g.account_id ORDER BY g.date) AS balance
    FROM grid g
    LEFT JOIN daily_changes dc ON g.date = dc.date AND g.account_id = dc.account_id
)
SELECT date, account_id, balance FROM balances;
