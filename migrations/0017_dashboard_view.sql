-- Dashboard data view
CREATE OR REPLACE VIEW dashboard_data AS
SELECT 
    t.date,
    e.amount_base,
    a.full_name AS account_name,
    a.type AS account_type,
    a.id AS account_id
FROM transactions t
JOIN entries e ON t.id = e.transaction_id
JOIN account_names_hierarchical a ON e.account_id = a.id;
