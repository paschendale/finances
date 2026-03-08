-- Drop existing view to avoid column mismatch errors
DROP VIEW IF EXISTS transactions_with_entries;

-- Recreate transactions_with_entries with strict ordering
CREATE OR REPLACE VIEW transactions_with_entries AS
SELECT 
    t.id,
    t.date,
    t.description,
    t.metadata,
    t.created_at,
    COALESCE(
        (
            SELECT jsonb_agg(jsonb_build_object(
                'id', e.id,
                'account_id', e.account_id,
                'account_name', a.full_name,
                'account_type', a.type,
                'amount', e.amount,
                'currency', e.currency,
                'exchange_rate', e.exchange_rate,
                'amount_base', e.amount_base,
                'created_at', e.created_at
            ) ORDER BY e.created_at DESC) -- Entries ordered by most recent first
            FROM entries e
            JOIN account_names_hierarchical a ON e.account_id = a.id
            WHERE e.transaction_id = t.id
        ),
        '[]'::jsonb
    ) AS entries
FROM transactions t
ORDER BY t.date DESC, t.created_at DESC;

-- Update description_memories_with_names to use hierarchical paths and order by updated_at
CREATE OR REPLACE VIEW description_memories_with_names AS
SELECT 
    m.description,
    m.category_id,
    c.full_name as category_name,
    m.account_id,
    a.full_name as account_name,
    m.currency,
    m.updated_at
FROM description_memories m
LEFT JOIN account_names_hierarchical c ON m.category_id = c.id
LEFT JOIN account_names_hierarchical a ON m.account_id = a.id
ORDER BY m.updated_at DESC;
