# Budget Module

## Overview

The Budget module gives the user visibility into spending goals by category. It answers two questions at a glance:

- **How much of my budget have I used this month?**
- **How much do I have left for the rest of the year?**

Budget items are defined per expense category with a total period amount and monthly min/max thresholds. The system does not enforce limits — thresholds are purely informational guides. A rolling adjustment automatically redistributes the remaining budget across future months whenever a past month runs over or under target.

The module is read-only by default (Execution mode). The user switches to Planning mode to create or edit a budget plan.

---

## Navigation

The Budget module is accessible from the top navigation bar, which becomes:

```
Dashboard | Ledger | Accounts | Budget
```

Within the Budget page, a secondary sub-switcher controls the mode:

```
Execution | Planning
```

- **Execution** is the default when entering the Budget page.
- **Planning** makes the interface editable.

Additional controls in the Budget page header:
- **Month navigator**: `← [Month Year] →` — browse months within the plan period.
- **View toggle**: `Monthly | Period` — monthly shows spending for the selected month; period shows cumulative for the full plan period.

---

## Data Model

### `budget_plans`

Represents a named budget plan covering a date range.

Fields:

```
id             UUID         Primary key
name           TEXT         User-given name (e.g. "2026 Annual Budget")
period_start   DATE         Start of the budget period (inclusive)
period_end     DATE         End of the budget period (inclusive)
is_current     BOOLEAN      Only one plan can be current at a time
created_at     TIMESTAMPTZ
```

Only one plan has `is_current = true` at any moment. Changing the current plan sets the new one to true and all others to false.

---

### `budget_items`

Represents a single category budget line within a plan.

Fields:

```
id              UUID       Primary key
plan_id         UUID       FK → budget_plans.id
account_id      UUID       FK → accounts.id (must be type = 'expense')
period_amount   NUMERIC    Total budget for the entire plan period
min_pct         NUMERIC    Minimum monthly spend as % of adjusted target (e.g. 60)
max_pct         NUMERIC    Maximum monthly spend as % of adjusted target (e.g. 140)
created_at      TIMESTAMPTZ
```

`period_amount` is the single source of truth. Monthly targets and thresholds are always derived from it.

Constraints:
- `account_id` must reference an account of type `expense`.
- `(plan_id, account_id)` is unique — a category appears at most once per plan.
- `min_pct >= 0`, `max_pct >= min_pct`.

---

## Derived Calculations

All monetary calculations are derived from `period_amount` and actual entries — nothing is stored.

### Base monthly target

```
num_months       = number of calendar months from period_start to period_end (inclusive)
base_monthly     = period_amount / num_months
```

Example: `period_amount = 12000`, `num_months = 12` → `base_monthly = 1000`.

---

### Rolling monthly adjustment

For month **M** (1-indexed within the plan period):

```
spent_to_date    = SUM(actual_spending for months 1 .. M-1)
remaining        = period_amount - spent_to_date
remaining_months = num_months - (M - 1)
adjusted_monthly = remaining / remaining_months
```

For **M = 1** (the first month of the plan): `adjusted_monthly = base_monthly` (no prior spending yet).

This means:
- If the user spent less than target in previous months, future months get a slightly higher target.
- If the user overspent, future months get a reduced target.

**Worked example:**

```
period_amount = 12000   (food budget, 12 months)
base_monthly  = 1000

Month 1: spent = 1200
Month 2 calculation:
  spent_to_date    = 1200
  remaining        = 12000 - 1200 = 10800
  remaining_months = 12 - 1 = 11
  adjusted_monthly = 10800 / 11 ≈ 981.82
```

---

### Monthly thresholds

Computed from `adjusted_monthly` for each month:

```
min_monthly  = adjusted_monthly × (min_pct / 100)
max_monthly  = adjusted_monthly × (max_pct / 100)
```

Example with `min_pct = 60`, `max_pct = 140`:

```
min_monthly  = 981.82 × 0.60 ≈ 589.09
max_monthly  = 981.82 × 1.40 ≈ 1374.55
```

---

## Budget Bar

The budget bar is the primary visual element. It shows current-month spending relative to thresholds.

### Three visual states

| State | Condition | Bar scale | Markers |
|---|---|---|---|
| Under target | `spent < adjusted_monthly` | 0 → adjusted_monthly (100%) | min only |
| Over target, within max | `adjusted_monthly ≤ spent ≤ max_monthly` | 0 → max_monthly | min, target, max |
| Over max | `spent > max_monthly` | 0 → spent | min, target, max |

**Marker positions** are always expressed as percentages of the bar's current scale:

```
min_position    = min_monthly  / bar_scale × 100%
target_position = adjusted_monthly / bar_scale × 100%
max_position    = max_monthly  / bar_scale × 100%
```

### Helper values

Displayed above (or below) the bar as a compact row of labeled values:

```
Min: [min_monthly]   Target: [adjusted_monthly]   Max: [max_monthly]   Remaining: [remaining]
```

Where `remaining = period_amount - SUM(all months spent so far)`.

### Colors

- Bar fill: neutral/white by default; red when `spent > max_monthly`; amber when approaching max (optional, implementation discretion)
- Min marker: muted line
- Target marker: accent (blue or white)
- Max marker: red/amber line

---

## Execution View

The default view when the user opens Budget.

**Layout:**
- Categories are displayed hierarchically: parent rows group their children with indentation.
- Each category shows its BudgetBar with helper values.
- Rows are non-editable.

**No current plan:** Display a centered empty state with a "Create Budget Plan" button that opens the Planning Wizard.

**Plan switcher:** A "Plans" button in the Budget page header opens the Plan List Modal.

**Interaction:**
- Clicking a category bar (or the row) navigates to the Ledger with filters pre-applied:
  - `accountIds` = [clicked account_id]
  - `startDate` = first day of current navigation month
  - `endDate` = last day of current navigation month
- The Ledger toolbar shows a `← Back to Budget` button that returns to the Budget/Execution view.

---

## Planning View

Toggling to Planning mode makes the interface editable.

### Plan List Modal

Opened via the "Plans" button in the Budget page header. Shows all existing plans and allows the user to switch the active plan or create a new one.

Contents:
- List of all `budget_plans` rows, ordered by `created_at desc`.
- Each row: plan name, period date range, a "Set as current" button (disabled if already current, shown with a check mark).
- "New Plan" button at the bottom → opens the Wizard.
- Modal closes on Escape or backdrop click.

On "Set as current": calls `set_current_budget_plan` RPC, invalidates budget queries, closes modal.

---

### Wizard (first time, no current plan)

Triggered when there is no current plan, or when the user clicks "New Plan" inside the Plan List Modal.

Steps:
1. **Name** — Text input. Placeholder: "2026 Annual Budget".
2. **Period** — Two date inputs: Start and End. Default: `YYYY-01-01` to `YYYY-12-31` for the current year.
3. **Confirm** — Creates the plan via `create_budget_plan` RPC, sets it as current, closes the wizard, and opens the Planning editing view.

The wizard is a modal overlay. Pressing Escape or clicking outside cancels without saving.

### Editing interface

Displayed once a current plan exists.

**Header:**
- Shows plan name and period dates (read-only).
- "New Plan" button to re-open the wizard.

**Category list:**
- All budgeted categories listed hierarchically (parent > child indented).
- Each row shows:
  - Category name (with AccountIcon)
  - Amount input with a Monthly ↔ Yearly toggle (switching recalculates the displayed value; `period_amount` is always stored as the total for the period)
  - Min % input
  - Max % input
  - BudgetBar preview (updates live as values change)
  - Remove button (×)

**Add category:**
- A search input at the bottom of the list filtered to `type = expense` accounts.
- Selecting an account adds it with default values: `period_amount = 0`, `min_pct = 60`, `max_pct = 140`.

**Save:**
- "Save" button persists all changes via `upsert_budget_item` RPCs.
- On success, returns to Execution view.

**Unsaved changes:**
- If the user switches to Execution mode with unsaved changes, display a discard confirmation.

---

## Frontend Components

| File | Responsibility |
|---|---|
| `app/src/components/BudgetPage.tsx` | Top-level layout: sub-mode switcher, month navigator, period toggle, wizard trigger |
| `app/src/components/BudgetBar.tsx` | Reusable bar component. Props: `spent`, `adjusted_monthly`, `min_pct`, `max_pct`, `period_remaining`. Renders the three states, markers, and helper values |
| `app/src/components/BudgetPlanListModal.tsx` | Modal listing all plans; set-as-current action; "New Plan" entry point |
| `app/src/components/BudgetPlanWizard.tsx` | Modal wizard for plan creation (name + period → save) |
| `app/src/components/BudgetExecutionView.tsx` | Read-only execution view. Fetches plan, items, and monthly spending. Renders category rows with BudgetBar |
| `app/src/components/BudgetPlanningView.tsx` | Editable planning view. Manages local state for items; calls upsert RPCs on save |
| `app/src/components/BudgetCategoryRow.tsx` | Single category row used in both modes. Planning mode adds amount/pct inputs |

---

## API

### New RPC Functions

#### `create_budget_plan`

Creates a new budget plan and marks it as the current plan (all other plans are set to `is_current = false`).

**Endpoint:** `POST /rpc/create_budget_plan`

**Arguments:**

| Name | Type | Description |
|---|---|---|
| `p_name` | TEXT | Plan name |
| `p_period_start` | DATE | Budget period start (YYYY-MM-DD) |
| `p_period_end` | DATE | Budget period end (YYYY-MM-DD) |

**Response:** The created `budget_plans` row.

---

#### `set_current_budget_plan`

Switches the active plan. Sets `is_current = true` for the given plan and `false` for all others.

**Endpoint:** `POST /rpc/set_current_budget_plan`

**Arguments:**

| Name | Type | Description |
|---|---|---|
| `p_plan_id` | UUID | Plan to make current |

**Response:** `true` on success.

---

#### `upsert_budget_item`

Inserts or updates a budget item for a given (plan, account) pair.

**Endpoint:** `POST /rpc/upsert_budget_item`

**Arguments:**

| Name | Type | Description |
|---|---|---|
| `p_plan_id` | UUID | Plan ID |
| `p_account_id` | UUID | Account ID (must be type=expense) |
| `p_period_amount` | NUMERIC | Total budget for the plan period |
| `p_min_pct` | NUMERIC | Minimum monthly % (e.g. 60) |
| `p_max_pct` | NUMERIC | Maximum monthly % (e.g. 140) |

**Response:** The upserted `budget_items` row.

---

#### `delete_budget_item`

Removes a budget item from a plan.

**Endpoint:** `POST /rpc/delete_budget_item`

**Arguments:**

| Name | Type | Description |
|---|---|---|
| `p_id` | UUID | Budget item ID |

**Response:** `true` if deleted.

---

### New Views

#### `budget_items_with_accounts`

Budget items joined with their account's full hierarchical name, type, icon, and color. Used by the frontend to render category rows without additional lookups.

**Endpoint:** `GET /budget_items_with_accounts`

| Property | Type | Description |
|---|---|---|
| `id` | UUID | Budget item ID |
| `plan_id` | UUID | Plan ID |
| `account_id` | UUID | Account ID |
| `account_full_name` | TEXT | Full hierarchical name (e.g. `expenses:food:grocery`) |
| `account_name` | TEXT | Leaf name only (e.g. `grocery`) |
| `icon` | TEXT | Account icon slug |
| `color` | TEXT | Account color hex |
| `parent_id` | UUID | Account parent ID (for hierarchy rendering) |
| `period_amount` | NUMERIC | Total period budget |
| `min_pct` | NUMERIC | Minimum monthly % |
| `max_pct` | NUMERIC | Maximum monthly % |

Supports filtering: `?plan_id=eq.<uuid>`

---

#### `budget_monthly_spending`

For each budget item, returns the actual spending per calendar month within the plan period. Spending is summed from `entries.amount_base` for the item's account and all its descendant accounts.

**Endpoint:** `GET /budget_monthly_spending`

| Property | Type | Description |
|---|---|---|
| `plan_id` | UUID | Plan ID |
| `account_id` | UUID | Account ID |
| `month` | DATE | First day of the month (e.g. `2026-01-01`) |
| `spent` | NUMERIC | Sum of amount_base for that account + descendants in that month |

Supports filtering: `?plan_id=eq.<uuid>`

---

## Migrations

Three migrations are needed. They must be applied in order.

### `0039_budget_plans.sql`

Creates `budget_plans` and `budget_items` tables with:
- Primary keys (UUID, `gen_random_uuid()`)
- Foreign key from `budget_items.plan_id` → `budget_plans.id` (cascade delete)
- Foreign key from `budget_items.account_id` → `accounts.id`
- Unique constraint on `(plan_id, account_id)`
- Check constraint: account must be type `expense` (enforced in the upsert RPC, not as a DB check, since the check would require a join)
- Check constraints: `min_pct >= 0`, `max_pct >= min_pct`

### `0040_budget_views.sql`

Creates `budget_items_with_accounts` and `budget_monthly_spending` views.

`budget_monthly_spending` must use a recursive CTE to include spending from all descendant accounts of each budget item's account (matching how `account_balances` handles hierarchical rollups).

### `0041_budget_rpcs.sql`

Creates the four RPC functions:
- `create_budget_plan` — inserts into `budget_plans`, sets `is_current=true`, updates all other plans to `is_current=false`
- `set_current_budget_plan` — same current-plan toggle logic
- `upsert_budget_item` — validates account type, then `INSERT ... ON CONFLICT (plan_id, account_id) DO UPDATE`
- `delete_budget_item` — deletes by id

All RPCs must be granted to the `authenticated` role.

---

## Design Notes

- Follow the existing Apple-style dark aesthetic: `backdrop-blur`, `bg-white/[0.02]`, `border-white/10`, Geist font, rounded cards.
- The BudgetBar should be visually prominent — thick, with clear threshold tick marks.
- Helper values above the bar should use the same muted mono style as amounts elsewhere in the app.
- The category hierarchy indentation should match the visual language of the Ledger's date-grouped rows.
- All monetary values use `amount_base` (base currency). No multi-currency budget items — budgets are always in base currency.
- The budget module reads from the ledger; it never writes transactions. It is entirely read-only from an accounting perspective.
