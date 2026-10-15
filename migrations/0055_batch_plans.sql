-- Migration 0055: batch plans and statement account references
--
-- * advisor_plans.statement_ids: one plan can cover several statement periods of one account
--   (statements that arrived together are checked in one plan). statement_id keeps pointing at
--   the first one for older readers.
-- * advisor_statements.account_ref: the bank-side account identifier (OFX ACCTID, Itaú agência-conta)
--   so the ledger account can be learned once and recorded as a note.
-- * advisor_plans_with_counts gains delete_count (recreated: the view expands p.*).

BEGIN;

ALTER TABLE advisor_plans ADD COLUMN IF NOT EXISTS statement_ids UUID[];
ALTER TABLE advisor_statements ADD COLUMN IF NOT EXISTS account_ref TEXT;

DROP VIEW IF EXISTS advisor_plans_with_counts;
CREATE VIEW advisor_plans_with_counts AS
SELECT
  p.*,
  COALESCE((SELECT count(*) FROM advisor_plan_items i WHERE i.plan_id = p.id AND i.status <> 'removed'), 0)::int AS item_count,
  COALESCE((SELECT count(*) FROM advisor_plan_items i WHERE i.plan_id = p.id AND i.status <> 'removed' AND i.kind = 'create'), 0)::int AS create_count,
  COALESCE((SELECT count(*) FROM advisor_plan_items i WHERE i.plan_id = p.id AND i.status <> 'removed' AND i.kind = 'update'), 0)::int AS update_count,
  COALESCE((SELECT count(*) FROM advisor_plan_items i WHERE i.plan_id = p.id AND i.status <> 'removed' AND i.kind = 'skip'), 0)::int AS skip_count,
  COALESCE((SELECT count(*) FROM advisor_plan_items i WHERE i.plan_id = p.id AND i.status <> 'removed' AND i.kind = 'adjust'), 0)::int AS adjust_count,
  COALESCE((SELECT count(*) FROM advisor_plan_items i WHERE i.plan_id = p.id AND i.status <> 'removed' AND i.kind = 'delete'), 0)::int AS delete_count,
  COALESCE((SELECT min(i.confidence) FROM advisor_plan_items i WHERE i.plan_id = p.id AND i.status <> 'removed' AND i.kind <> 'skip'), 1) AS min_confidence
FROM advisor_plans p;
GRANT SELECT ON advisor_plans_with_counts TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
