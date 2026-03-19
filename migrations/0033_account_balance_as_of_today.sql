-- Migration 0033: Filter account_balances to current date and expose future_balance
--
-- Balances should only reflect entries up to today. Installment transactions
-- create future-dated entries which would otherwise inflate current balances.
-- future_balance (and future_own_balance) hold the pending future amount so
-- the UI can warn the user that additional entries exist beyond today.

DROP VIEW IF EXISTS account_balances CASCADE;

CREATE OR REPLACE VIEW account_balances AS
WITH account_own_data AS (
    SELECT
        a.id,
        COALESCE(SUM(e.amount_base) FILTER (WHERE t.date <= CURRENT_DATE), 0) AS own_balance,
        COALESCE(SUM(e.amount_base) FILTER (WHERE t.date > CURRENT_DATE), 0)  AS future_own_balance,
        MAX(t.date) FILTER (WHERE t.date <= CURRENT_DATE)                      AS own_last_entry_date
    FROM accounts a
    LEFT JOIN entries e ON a.id = e.account_id
    LEFT JOIN transactions t ON e.transaction_id = t.id
    GROUP BY a.id
)
SELECT
    h.id          AS account_id,
    h.full_name   AS account_name,
    h.name        AS leaf_name,
    h.type        AS account_type,
    h.parent_id,
    d_data.own_balance        AS own_balance,
    d_data.future_own_balance AS future_own_balance,
    (
        SELECT COALESCE(SUM(desc_data.own_balance), 0)
        FROM account_names_hierarchical d
        JOIN account_own_data desc_data ON d.id = desc_data.id
        WHERE d.full_name = h.full_name
           OR d.full_name LIKE h.full_name || ':%'
    ) AS balance,
    (
        SELECT COALESCE(SUM(desc_data.future_own_balance), 0)
        FROM account_names_hierarchical d
        JOIN account_own_data desc_data ON d.id = desc_data.id
        WHERE d.full_name = h.full_name
           OR d.full_name LIKE h.full_name || ':%'
    ) AS future_balance,
    (
        SELECT MAX(desc_data.own_last_entry_date)
        FROM account_names_hierarchical d
        JOIN account_own_data desc_data ON d.id = desc_data.id
        WHERE d.full_name = h.full_name
           OR d.full_name LIKE h.full_name || ':%'
    ) AS last_entry_date,
    h.icon,
    h.color,
    h.hidden
FROM account_names_hierarchical h
LEFT JOIN account_own_data d_data ON h.id = d_data.id;
