-- Migration 0057: when an account is due for a balance check
--
-- Until now three places decided this with flat thresholds (dashboard: 7 days; advisor chips and
-- daily nudge: 30 days, plus "any entry after the last check"), so empty accounts idle for months and
-- property with no statement at all were asked about forever. One view now decides, from how the
-- account is actually used:
--
--   never         hidden, subtype `property`, or check_every_days = 0
--   fixed         check_every_days = N > 0           → every N days
--   active        ≥ 9 transactions in 90 days and one in the last 30 → every 30 days; new entries
--                 alone do not make it due (a statement covering the period counts as a check)
--   occasional    some entry in the last 90 days     → 7 days after the first entry since the last
--                 check, else every 90 days
--   dormant       no entry in 90 days, holds money   → 7 days after a new entry, else every 180 days
--   dormant_empty no entry in 90 days, balance zero  → never; a new entry (a transfer in) makes it
--                 occasional again
--
-- The last check is the later of accounts.last_checked (local date) and the reconciliation's
-- reconciled_through. check_reason says what sets check_due_on: never_checked, moved or cadence.
-- Parents count their descendants' entries, like account_balances.
-- account_balances gains the result as trailing columns (shape of 0051 kept).

BEGIN;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS check_every_days INTEGER NULL CHECK (check_every_days IS NULL OR check_every_days >= 0);

COMMENT ON COLUMN accounts.check_every_days IS
  'Balance check cadence: NULL = automatic (account_check_status), 0 = never ask, N = every N days';

CREATE OR REPLACE VIEW account_check_status AS
WITH subtree AS (
    SELECT h.id AS account_id, d.id AS member_id
    FROM account_names_hierarchical h
    JOIN account_names_hierarchical d
      ON d.full_name = h.full_name OR d.full_name LIKE h.full_name || ':%'
),
base AS (
    SELECT
        a.id AS account_id,
        a.type,
        a.subtype,
        a.hidden,
        a.check_every_days,
        CASE
            WHEN a.last_checked IS NULL THEN rs.reconciled_through
            WHEN rs.reconciled_through IS NULL THEN (a.last_checked AT TIME ZONE 'America/Sao_Paulo')::date
            ELSE GREATEST((a.last_checked AT TIME ZONE 'America/Sao_Paulo')::date, rs.reconciled_through)
        END AS checked_on
    FROM accounts a
    LEFT JOIN account_reconciliation_status rs ON rs.account_id = a.id
),
activity AS (
    SELECT
        s.account_id,
        COALESCE(SUM(e.amount_base) FILTER (WHERE t.id IS NOT NULL), 0)        AS balance,
        MAX(t.date)                                                            AS last_entry_date,
        COUNT(DISTINCT t.id) FILTER (WHERE t.date > CURRENT_DATE - 90)         AS tx_90,
        MIN(t.date) FILTER (WHERE b.checked_on IS NULL OR t.date > b.checked_on) AS first_unchecked_on
    FROM subtree s
    JOIN base b ON b.account_id = s.account_id
    LEFT JOIN entries e ON e.account_id = s.member_id
    LEFT JOIN transactions t ON t.id = e.transaction_id AND t.date <= CURRENT_DATE
    GROUP BY s.account_id
),
tiered AS (
    SELECT
        b.account_id,
        b.check_every_days,
        b.checked_on,
        act.first_unchecked_on,
        CASE
            WHEN b.type NOT IN ('asset', 'liability') THEN NULL
            WHEN b.hidden THEN 'never'
            WHEN b.check_every_days = 0 THEN 'never'
            WHEN b.check_every_days > 0 THEN 'fixed'
            WHEN b.subtype = 'property' THEN 'never'
            WHEN act.last_entry_date IS NULL OR act.last_entry_date <= CURRENT_DATE - 90 THEN
                CASE WHEN abs(act.balance) < 0.01 THEN 'dormant_empty' ELSE 'dormant' END
            WHEN act.tx_90 >= 9 AND act.last_entry_date > CURRENT_DATE - 30 THEN 'active'
            ELSE 'occasional'
        END AS check_tier
    FROM base b
    JOIN activity act ON act.account_id = b.account_id
),
dated AS (
    SELECT
        t.*,
        -- LEAST ignores NULLs: a never-checked account is due 7 days after its first entry.
        CASE t.check_tier
            WHEN 'fixed'      THEN COALESCE(t.checked_on + t.check_every_days, CURRENT_DATE)
            WHEN 'active'     THEN COALESCE(t.checked_on + 30, CURRENT_DATE)
            WHEN 'occasional' THEN COALESCE(LEAST(t.checked_on + 90, t.first_unchecked_on + 7), CURRENT_DATE)
            WHEN 'dormant'    THEN COALESCE(LEAST(t.checked_on + 180, t.first_unchecked_on + 7), CURRENT_DATE)
        END AS check_due_on
    FROM tiered t
)
SELECT
    d.account_id,
    d.check_every_days,
    d.check_tier,
    d.checked_on,
    d.check_due_on,
    COALESCE(d.check_due_on <= CURRENT_DATE, false) AS check_due,
    CASE
        WHEN d.check_due_on IS NULL THEN NULL
        WHEN d.checked_on IS NULL THEN 'never_checked'
        WHEN d.check_tier IN ('occasional', 'dormant') AND d.check_due_on = d.first_unchecked_on + 7 THEN 'moved'
        ELSE 'cadence'
    END AS check_reason,
    d.first_unchecked_on IS NOT NULL AS moved_since_check
FROM dated d;

GRANT SELECT ON account_check_status TO authenticated;

-- account_balances: append the check status (0051 shape kept).
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
),
cleared AS (
    SELECT e.account_id, COALESCE(SUM(e.amount_base), 0) AS cleared_balance
    FROM entries e
    JOIN transactions t ON t.id = e.transaction_id
    JOIN entry_clearings ec ON ec.entry_id = e.id
    WHERE t.date <= CURRENT_DATE
    GROUP BY e.account_id
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
    h.hidden,
    a.last_checked AS last_checked,
    rs.reconciled_through,
    COALESCE(c.cleared_balance, 0) AS cleared_balance,
    cs.check_every_days,
    cs.check_tier,
    cs.check_due_on,
    cs.check_due,
    cs.check_reason,
    cs.moved_since_check
FROM account_names_hierarchical h
JOIN accounts a ON h.id = a.id
LEFT JOIN account_own_data d_data ON h.id = d_data.id
LEFT JOIN account_reconciliation_status rs ON rs.account_id = h.id
LEFT JOIN cleared c ON c.account_id = h.id
LEFT JOIN account_check_status cs ON cs.account_id = h.id;

GRANT SELECT ON account_balances TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
