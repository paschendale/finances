-- Migration 0052: non-liquid account subtypes and account plan items
--
-- * accounts.subtype gains `property` (assets that are not money: a house, a car) and `loan`
--   (long-term liabilities: a mortgage, a financing). The dashboard shows checking / emergency /
--   investments / liabilities as money; property and loan accounts stay out of those cards and of
--   the "net worth" line, but remain visible, postable ledger accounts.
-- * advisor_plan_items.kind gains `account_create` and `account_update`, so the advisor can propose
--   new accounts (and changes to existing ones) inside a plan that a person approves.
--
-- Both changes only widen CHECK constraints; no data is touched.

BEGIN;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_subtype_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_subtype_check
  CHECK (subtype IN ('checking', 'emergency', 'investments', 'liabilities', 'category', 'property', 'loan'));

ALTER TABLE advisor_plan_items DROP CONSTRAINT IF EXISTS advisor_plan_items_kind_check;
ALTER TABLE advisor_plan_items
  ADD CONSTRAINT advisor_plan_items_kind_check
  CHECK (kind IN ('create', 'update', 'delete', 'adjust', 'budget_upsert', 'budget_delete', 'mark_checked', 'skip', 'account_create', 'account_update'));

NOTIFY pgrst, 'reload schema';

COMMIT;
