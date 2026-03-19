-- Migration 0035: Add subtype column and flatten remaining container accounts
--
-- Adds a `subtype` column to accounts to replace structural hierarchy for
-- asset categorization (checking, emergency, investments) and liabilities.
-- Container accounts (checking, emergency, investments, credit-card) are
-- promoted to root and then deleted, reducing 133 accounts to 129.

BEGIN;

-- Step 1: Add subtype column
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS subtype TEXT
  CHECK (subtype IN ('checking', 'emergency', 'investments', 'liabilities', 'category'));

-- Step 2: Backfill subtypes BEFORE removing containers
-- Asset subtypes: set on children using their current parent's name
UPDATE accounts SET subtype = 'checking'
WHERE parent_id = (SELECT id FROM accounts WHERE name = 'checking' AND parent_id IS NULL);

UPDATE accounts SET subtype = 'emergency'
WHERE parent_id = (SELECT id FROM accounts WHERE name = 'emergency' AND parent_id IS NULL);

UPDATE accounts SET subtype = 'investments'
WHERE parent_id = (SELECT id FROM accounts WHERE name = 'investments' AND parent_id IS NULL);

-- Liability subtype: children of credit-card
UPDATE accounts SET subtype = 'liabilities'
WHERE parent_id = (SELECT id FROM accounts WHERE name = 'credit-card' AND parent_id IS NULL);

-- Also any root liability accounts not under credit-card
UPDATE accounts SET subtype = 'liabilities'
WHERE type = 'liability' AND subtype IS NULL;

-- Category subtype: all expense and income accounts
UPDATE accounts SET subtype = 'category'
WHERE type IN ('expense', 'income');

-- Step 3: Promote children to root
UPDATE accounts SET parent_id = NULL
WHERE parent_id = (SELECT id FROM accounts WHERE name = 'checking' AND parent_id IS NULL);

UPDATE accounts SET parent_id = NULL
WHERE parent_id = (SELECT id FROM accounts WHERE name = 'emergency' AND parent_id IS NULL);

UPDATE accounts SET parent_id = NULL
WHERE parent_id = (SELECT id FROM accounts WHERE name = 'investments' AND parent_id IS NULL);

UPDATE accounts SET parent_id = NULL
WHERE parent_id = (SELECT id FROM accounts WHERE name = 'credit-card' AND parent_id IS NULL);

-- Step 4: Delete container accounts (safety guard: only if no ledger entries)
DELETE FROM accounts
WHERE name IN ('checking', 'emergency', 'investments', 'credit-card')
  AND parent_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM entries WHERE account_id = accounts.id);

-- Step 5: Update account_balances view to expose subtype
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
    a.subtype,
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
JOIN accounts a ON h.id = a.id
LEFT JOIN account_own_data d_data ON h.id = d_data.id;

-- Step 6: Update daily_balances view to use subtype column
CREATE OR REPLACE VIEW daily_balances AS
WITH dates AS (
    SELECT generate_series(
        COALESCE((SELECT MIN(date) FROM transactions), CURRENT_DATE),
        CURRENT_DATE,
        '1 day'::interval
    )::date AS date
),
categories AS (
    SELECT 'asset' as type UNION ALL
    SELECT 'liability' as type UNION ALL
    SELECT 'expense' as type UNION ALL
    SELECT 'income' as type UNION ALL
    SELECT 'equity' as type UNION ALL
    SELECT 'checking' as type UNION ALL
    SELECT 'emergency' as type UNION ALL
    SELECT 'investments' as type UNION ALL
    SELECT 'liabilities' as type
),
grid AS (
    SELECT d.date, c.type
    FROM dates d, categories c
),
daily_changes AS (
    SELECT
        t.date,
        a.type AS account_type,
        a.subtype,
        SUM(e.amount_base) AS change
    FROM transactions t
    JOIN entries e ON t.id = e.transaction_id
    JOIN accounts a ON e.account_id = a.id
    GROUP BY 1, 2, 3
),
daily_category_changes AS (
    -- Original types
    SELECT date, account_type as type, SUM(change) as change FROM daily_changes GROUP BY 1, 2
    UNION ALL
    -- Subtypes from the subtype column
    SELECT date, subtype AS type, SUM(change) AS change
    FROM daily_changes
    WHERE subtype IN ('checking', 'emergency', 'investments', 'liabilities')
    GROUP BY 1, 2
),
balances AS (
    SELECT
        g.date,
        g.type as account_type,
        SUM(COALESCE(dc.change, 0)) OVER (PARTITION BY g.type ORDER BY g.date) AS balance
    FROM grid g
    LEFT JOIN daily_category_changes dc ON g.date = dc.date AND g.type = dc.type
)
SELECT date, account_type::text, balance FROM balances
UNION ALL
SELECT
    date,
    'net_worth'::text as account_type,
    SUM(CASE WHEN account_type IN ('asset', 'liability', 'equity') THEN balance ELSE 0 END) as balance
FROM balances
WHERE account_type IN ('asset', 'liability', 'equity')
GROUP BY date;

NOTIFY pgrst, 'reload schema';

COMMIT;
