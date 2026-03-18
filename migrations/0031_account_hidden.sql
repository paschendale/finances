-- 0031_account_hidden.sql
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- Rebuild hierarchical view to expose hidden (appended at end — compatible with CREATE OR REPLACE)
CREATE OR REPLACE VIEW account_names_hierarchical AS
WITH RECURSIVE account_tree AS (
    SELECT id, name, name AS full_name, type, parent_id, icon, color, hidden
    FROM accounts WHERE parent_id IS NULL
    UNION ALL
    SELECT a.id, a.name, at.full_name || ':' || a.name,
           a.type, a.parent_id, a.icon, a.color, a.hidden
    FROM accounts a
    JOIN account_tree at ON a.parent_id = at.id
)
SELECT * FROM account_tree;

-- Rebuild account_balances to expose hidden (appended at end — compatible with CREATE OR REPLACE)
CREATE OR REPLACE VIEW account_balances AS
SELECT
    a.id          AS account_id,
    a.full_name   AS account_name,
    a.type        AS account_type,
    COALESCE(SUM(e.amount_base), 0) AS balance,
    a.icon,
    a.color,
    a.hidden
FROM account_names_hierarchical a
LEFT JOIN entries e ON a.id = e.account_id
GROUP BY a.id, a.full_name, a.type, a.icon, a.color, a.hidden;

-- Rebuild account_usage to expose hidden (DROP required: adding hidden before last_used_at changes column positions)
DROP VIEW IF EXISTS account_usage CASCADE;
CREATE VIEW account_usage AS
SELECT
    a.id               AS account_id,
    h.full_name        AS account_name,
    a.type             AS account_type,
    COUNT(e.id)        AS usage_count,
    MAX(e.created_at)  AS last_used_at,
    a.hidden
FROM accounts a
JOIN account_names_hierarchical h ON a.id = h.id
LEFT JOIN entries e ON a.id = e.account_id
GROUP BY a.id, h.full_name, a.type, a.hidden;
