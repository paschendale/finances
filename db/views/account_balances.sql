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
