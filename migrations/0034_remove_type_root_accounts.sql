-- Remove redundant type-named root accounts (assets, expenses, liabilities, income)
-- These names duplicate the `type` column and add depth without semantic value.
-- Children are promoted one level up; container accounts are deleted.
--
-- Note on `receitas`: it is promoted to root (detached from `income`) but kept as a
-- grouping account because its children share names with expense accounts (e.g. `territorial`).
-- Resulting paths: receitas:ibge, receitas:topocart, etc. (2 levels, cleaner than before).

BEGIN;

-- Step 1: Detach children of `assets` → checking, emergency, investments become roots
UPDATE accounts SET parent_id = NULL
WHERE parent_id = (SELECT id FROM accounts WHERE name = 'assets' AND type = 'asset' AND parent_id IS NULL);

-- Step 2: Detach children of `expenses` → all expense subcategories become roots
UPDATE accounts SET parent_id = NULL
WHERE parent_id = (SELECT id FROM accounts WHERE name = 'expenses' AND type = 'expense' AND parent_id IS NULL);

-- Step 3: Detach children of `liabilities` → credit-card becomes root
UPDATE accounts SET parent_id = NULL
WHERE parent_id = (SELECT id FROM accounts WHERE name = 'liabilities' AND type = 'liability' AND parent_id IS NULL);

-- Step 4: Detach children of `income` → `receitas` becomes root (kept as grouping)
UPDATE accounts SET parent_id = NULL
WHERE parent_id = (SELECT id FROM accounts WHERE name = 'income' AND type = 'income' AND parent_id IS NULL);

-- Step 5: Delete the now-orphaned type-named container accounts
DELETE FROM accounts
WHERE name IN ('assets', 'expenses', 'liabilities', 'income')
  AND parent_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM entries e JOIN transactions t ON e.transaction_id = t.id WHERE e.account_id = accounts.id);

-- Step 6: Update daily_balances view — path patterns are now one level shallower
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
    SELECT 'credit-card' as type
),
grid AS (
    SELECT d.date, c.type
    FROM dates d, categories c
),
daily_changes AS (
    SELECT
        t.date,
        a.type AS account_type,
        an.full_name,
        SUM(e.amount_base) AS change
    FROM transactions t
    JOIN entries e ON t.id = e.transaction_id
    JOIN accounts a ON e.account_id = a.id
    JOIN account_names_hierarchical an ON a.id = an.id
    GROUP BY 1, 2, 3
),
daily_category_changes AS (
    -- Original types
    SELECT date, account_type as type, SUM(change) as change FROM daily_changes GROUP BY 1, 2
    UNION ALL
    -- Subtypes based on full_name patterns (paths now start one level shallower)
    SELECT
        date,
        CASE
            WHEN full_name LIKE 'checking:%' OR full_name = 'checking' THEN 'checking'
            WHEN full_name LIKE 'emergency:%' OR full_name = 'emergency' THEN 'emergency'
            WHEN full_name LIKE 'investments:%' OR full_name = 'investments' THEN 'investments'
            WHEN full_name LIKE 'credit-card:%' OR full_name = 'credit-card' THEN 'credit-card'
            ELSE 'other'
        END as type,
        SUM(change) as change
    FROM daily_changes
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
WHERE account_type != 'other'
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
