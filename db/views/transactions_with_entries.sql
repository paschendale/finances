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
