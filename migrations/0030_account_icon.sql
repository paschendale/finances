-- 0030_account_icon.sql
-- Add icon and color columns to accounts; expose in hierarchical view + balances

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS icon TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS color TEXT;

-- Rebuild account_names_hierarchical to expose icon + color from leaf account
CREATE OR REPLACE VIEW account_names_hierarchical AS
WITH RECURSIVE account_tree AS (
    -- Base case: root accounts
    SELECT
        id,
        name,
        name AS full_name,
        type,
        parent_id,
        icon,
        color
    FROM accounts
    WHERE parent_id IS NULL

    UNION ALL

    -- Recursive step: child accounts
    SELECT
        a.id,
        a.name,
        at.full_name || ':' || a.name AS full_name,
        a.type,
        a.parent_id,
        a.icon,
        a.color
    FROM accounts a
    JOIN account_tree at ON a.parent_id = at.id
)
SELECT * FROM account_tree;

-- Rebuild account_balances to expose icon + color
CREATE OR REPLACE VIEW account_balances AS
SELECT
    a.id AS account_id,
    a.full_name AS account_name,
    a.type AS account_type,
    a.icon AS icon,
    a.color AS color,
    COALESCE(SUM(e.amount_base), 0) AS balance
FROM account_names_hierarchical a
LEFT JOIN entries e ON a.id = e.account_id
GROUP BY a.id, a.full_name, a.type, a.icon, a.color;
