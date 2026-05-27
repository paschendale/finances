-- Migration 0045: Drop stale upsert_budget_item overloads
-- 0041 created a 5-param version; 0042 created a 6-param version (both superseded by 0044's 7-param version)
-- CREATE OR REPLACE does not replace across different signatures, so the old overloads accumulated.

DROP FUNCTION IF EXISTS upsert_budget_item(UUID, UUID, NUMERIC, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS upsert_budget_item(UUID, UUID, NUMERIC, NUMERIC, NUMERIC, INTEGER);

NOTIFY pgrst, 'reload schema';
