-- Migration 0032: Add hierarchical balances and last transaction date to account_balances

-- Drop existing view first
DROP VIEW IF EXISTS account_balances CASCADE;

-- Recreate account_balances with hierarchical rollups
CREATE OR REPLACE VIEW account_balances AS
WITH account_own_data AS (
    -- Calculate balance and last entry date for each individual account
    SELECT 
        a.id,
        COALESCE(SUM(e.amount_base), 0) AS own_balance,
        MAX(t.date) AS own_last_entry_date
    FROM accounts a
    LEFT JOIN entries e ON a.id = e.account_id
    LEFT JOIN transactions t ON e.transaction_id = t.id
    GROUP BY a.id
)
SELECT
    h.id AS account_id,
    h.full_name AS account_name,
    h.name AS leaf_name,
    h.type AS account_type,
    h.parent_id,
    d_data.own_balance AS own_balance,
    (
        -- Sum own_balance of self and all descendants
        SELECT SUM(d.own_balance)
        FROM account_names_hierarchical d
        JOIN account_own_data d_data ON d.id = d_data.id
        WHERE d.full_name = h.full_name 
           OR d.full_name LIKE h.full_name || ':%'
    ) AS balance,
    (
        -- Get max last_entry_date of self and all descendants
        SELECT MAX(d_data.own_last_entry_date)
        FROM account_names_hierarchical d
        JOIN account_own_data d_data ON d.id = d_data.id
        WHERE d.full_name = h.full_name 
           OR d.full_name LIKE h.full_name || ':%'
    ) AS last_entry_date,
    h.icon,
    h.color,
    h.hidden
FROM account_names_hierarchical h;
