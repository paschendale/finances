-- Migration 0049: suspense account for reconciliation adjustments
--
-- `ajustes` is the ledger's suspense account. Positive balance = unexplained outflow,
-- negative = unexplained inflow. Every reconciliation adjustment booked by the advisor goes
-- here (never to sem-categoria), so the balance itself is the list of what is still
-- unexplained. Expense type on purpose: daily_balances.net_worth includes equity, so an
-- equity-typed suspense account would cancel itself out of the chart (see LEDGER.md).

INSERT INTO accounts (name, type, subtype, icon)
SELECT 'ajustes', 'expense', 'category', 'scale'
WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE parent_id IS NULL AND name = 'ajustes');

NOTIFY pgrst, 'reload schema';
