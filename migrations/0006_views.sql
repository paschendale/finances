-- Account balances view
CREATE OR REPLACE VIEW account_balances AS
SELECT 
    a.id AS account_id,
    a.name AS account_name,
    a.type AS account_type,
    COALESCE(SUM(e.amount_base), 0) AS balance
FROM accounts a
LEFT JOIN entries e ON a.id = e.account_id
GROUP BY a.id, a.name, a.type;

-- Transactions with entries view
CREATE OR REPLACE VIEW transactions_with_entries AS
SELECT 
    t.id,
    t.date,
    t.description,
    t.metadata,
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
FROM transactions t
ORDER BY t.date DESC, t.created_at DESC;

-- Category totals view (expenses and income)
CREATE OR REPLACE VIEW category_totals AS
SELECT 
    a.name AS category_name,
    a.type AS category_type,
    SUM(e.amount_base) AS total
FROM accounts a
JOIN entries e ON a.id = e.account_id
WHERE a.type IN ('expense', 'income')
GROUP BY a.name, a.type;
