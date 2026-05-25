# Budget Module Backlog

Spec: [docs/BUDGET_MODULE.md](docs/BUDGET_MODULE.md)  
Domain model: [docs/DOMAINS.md](docs/DOMAINS.md) (budget_plans, budget_items sections)  
API contract: [docs/API_CONTRACT.md](docs/API_CONTRACT.md) (Budget Module section)

---

## Phase 1 — Database

- [ ] `0039_budget_plans.sql` — `budget_plans` and `budget_items` tables
- [ ] `0040_budget_views.sql` — `budget_items_with_accounts` and `budget_monthly_spending` views
- [ ] `0041_budget_rpcs.sql` — `create_budget_plan`, `set_current_budget_plan`, `upsert_budget_item`, `delete_budget_item`

## Phase 2 — Budget Page Shell

- [ ] Add `budget` to the view type in `App.tsx`; add "Budget" tab to top nav
- [ ] `BudgetPage.tsx` — sub-switcher (Execution | Planning), month navigator, period toggle, "Plans" button

## Phase 3 — Execution View

- [ ] `BudgetBar.tsx` — bar with 3 states, threshold markers, helper values
- [ ] `BudgetCategoryRow.tsx` — category name + icon + BudgetBar
- [ ] `BudgetExecutionView.tsx` — fetch current plan + items + monthly spending; render hierarchical rows; click-through to Ledger; empty state
- [ ] "← Back to Budget" button in LedgerTable toolbar (when navigated from Budget)

## Phase 4 — Planning View

- [ ] `BudgetPlanWizard.tsx` — name + period modal → `create_budget_plan`
- [ ] `BudgetPlanListModal.tsx` — list all plans, set-as-current, open wizard
- [ ] `BudgetPlanningView.tsx` — editable category list; add/remove categories; amount + min%/max% inputs; live BudgetBar preview; save via `upsert_budget_item`
