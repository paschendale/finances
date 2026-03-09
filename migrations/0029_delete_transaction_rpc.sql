-- Migration 0029: Delete transaction RPC and improved account usage views

-- Function to delete a transaction and its associated entries
CREATE OR REPLACE FUNCTION delete_transaction(p_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    DELETE FROM transactions WHERE id = p_id;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- View to track usage of all accounts, not just expenses/income
-- Useful for suggested accounts in transfers
CREATE OR REPLACE VIEW account_usage AS
SELECT 
    a.id as account_id,
    h.full_name as account_name,
    a.type as account_type,
    COUNT(e.id) as usage_count,
    MAX(e.created_at) as last_used_at
FROM accounts a
JOIN account_names_hierarchical h ON a.id = h.id
LEFT JOIN entries e ON a.id = e.account_id
GROUP BY a.id, h.full_name, a.type;
