-- Hierarchical account names view using recursive CTE
CREATE OR REPLACE VIEW account_names_hierarchical AS
WITH RECURSIVE account_tree AS (
    -- Base case: root accounts
    SELECT 
        id,
        name,
        name AS full_name,
        type,
        parent_id
    FROM accounts
    WHERE parent_id IS NULL
    
    UNION ALL
    
    -- Recursive step: child accounts
    SELECT 
        a.id,
        a.name,
        at.full_name || ':' || a.name AS full_name,
        a.type,
        a.parent_id
    FROM accounts a
    JOIN account_tree at ON a.parent_id = at.id
)
SELECT * FROM account_tree;

-- Update account_balances to use full_name
CREATE OR REPLACE VIEW account_balances AS
SELECT 
    a.id AS account_id,
    a.full_name AS account_name,
    a.type AS account_type,
    COALESCE(SUM(e.amount_base), 0) AS balance
FROM account_names_hierarchical a
LEFT JOIN entries e ON a.id = e.account_id
GROUP BY a.id, a.full_name, a.type;

-- Update transactions_with_entries to use full_name
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
                'account_name', a.full_name,
                'account_type', a.type,
                'amount', e.amount,
                'currency', e.currency,
                'exchange_rate', e.exchange_rate,
                'amount_base', e.amount_base
            ) ORDER BY e.created_at)
            FROM entries e
            JOIN account_names_hierarchical a ON e.account_id = a.id
            WHERE e.transaction_id = t.id
        ),
        '[]'::jsonb
    ) AS entries
FROM transactions t
ORDER BY t.date DESC, t.created_at DESC;

-- Update category_totals to use full_name
CREATE OR REPLACE VIEW category_totals AS
SELECT 
    a.full_name AS category_name,
    a.type AS category_type,
    SUM(e.amount_base) AS total
FROM account_names_hierarchical a
JOIN entries e ON a.id = e.account_id
WHERE a.type IN ('expense', 'income')
GROUP BY a.full_name, a.type;
