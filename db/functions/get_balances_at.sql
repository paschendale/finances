-- Function to fetch account balances at a specific date
CREATE OR REPLACE FUNCTION get_balances_at(p_date DATE)
RETURNS TABLE (
    account_id UUID,
    account_name TEXT,
    account_type TEXT,
    balance NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        a.id AS account_id,
        a.name AS account_name,
        a.type AS account_type,
        COALESCE(SUM(e.amount_base), 0) AS balance
    FROM accounts a
    LEFT JOIN entries e ON a.id = e.account_id
    LEFT JOIN transactions t ON e.transaction_id = t.id
    WHERE t.date <= p_date OR e.id IS NULL
    GROUP BY a.id, a.name, a.type;
END;
$$ LANGUAGE plpgsql;
