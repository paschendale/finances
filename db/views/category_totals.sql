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
