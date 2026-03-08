-- Function to fetch account balances at a specific date
-- This uses the hierarchical account names for consistency
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
        a.full_name AS account_name,
        a.type AS account_type,
        COALESCE(sub.balance, 0) AS balance
    FROM account_names_hierarchical a
    LEFT JOIN (
        SELECT e.account_id, SUM(e.amount_base) AS balance
        FROM entries e
        JOIN transactions t ON e.transaction_id = t.id
        WHERE t.date <= p_date
        GROUP BY e.account_id
    ) sub ON a.id = sub.account_id;
END;
$$ LANGUAGE plpgsql;
