# API Contract

This document defines the RPC functions and API endpoints available in the system.

## Database RPC Functions

These functions are exposed via PostgREST at `/rpc/<function_name>`.

---

### `login_with_token`

Authenticates a plain-text access token and returns a signed JWT.

**Endpoint:** `POST /rpc/login_with_token`

**Arguments:**

| Name | Type | Description |
| :--- | :--- | :--- |
| `token` | `TEXT` | Plain-text access token. |

**Response:** JWT string (plain text, not JSON).

**Notes:**
- Available to the `anon` role (no JWT required).
- Token is verified by SHA-256 hash against the `auth_tokens` table.
- JWT expires after 7 days and contains `role: authenticated`.

**Example Request:**

```bash
curl -X POST https://api-finances-dev.marotta.dev/rpc/login_with_token \
-H "Content-Type: application/json" \
-d '{"token": "my-plain-text-token"}'
```

---

### `create_transaction`

Creates a new transaction along with its associated entries in a single atomic operation.

**Endpoint:** `POST /rpc/create_transaction`

**Arguments:**

| Name | Type | Description |
| :--- | :--- | :--- |
| `p_date` | `DATE` | The date of the transaction (YYYY-MM-DD). |
| `p_description` | `TEXT` | A human-readable description of the transaction. |
| `p_entries` | `JSONB` | An array of entry objects. |

**Entry Object:**

| Property | Type | Description |
| :--- | :--- | :--- |
| `account_id` | `UUID` | ID of the account for this entry. |
| `amount` | `NUMERIC` | The amount in the original currency. |
| `currency` | `TEXT` | ISO currency code (e.g., "BRL", "USD"). |
| `exchange_rate`| `NUMERIC` | Conversion rate to base currency (default: 1.0). |
| `amount_base` | `NUMERIC` | The amount converted to the base currency. |

**Constraints:**

- Must have at least two entries.
- The sum of all `amount_base` in `p_entries` must be exactly `0.00`.
- All `account_id` must exist.

**Side effects:** Updates `description_memories` and `global_settings` (last used account/currency).

**Example Request:**

```bash
curl -X POST https://api-finances-dev.marotta.dev/rpc/create_transaction \
-H "Content-Type: application/json" \
-H "Authorization: Bearer <jwt>" \
-d '{
  "p_date": "2026-03-08",
  "p_description": "Salary",
  "p_entries": [
    {
      "account_id": "7a373e9e-9d90-4f49-90ee-ff80afbe520d",
      "amount": 5000.00,
      "currency": "BRL",
      "exchange_rate": 1.0,
      "amount_base": 5000.00
    },
    {
      "account_id": "768520a9-3239-458b-b988-2d5368b7b762",
      "amount": -5000.00,
      "currency": "BRL",
      "exchange_rate": 1.0,
      "amount_base": -5000.00
    }
  ]
}'
```

**Success Response (200 OK):** Returns the created transaction with nested entries as JSONB.

**Error Response:**

```json
{
  "code": "P0001",
  "message": "Transaction is not balanced: SUM(amount_base) = 50.00",
  "details": null,
  "hint": null
}
```

---

### `update_transaction`

Updates an existing transaction and its entries. Atomically replaces old entries with new ones.

**Endpoint:** `POST /rpc/update_transaction`

**Arguments:**

| Name | Type | Description |
| :--- | :--- | :--- |
| `p_id` | `UUID` | The ID of the transaction to update. |
| `p_date` | `DATE` | The new date (YYYY-MM-DD). |
| `p_description` | `TEXT` | The new description. |
| `p_entries` | `JSONB` | Array of entry objects (same schema as `create_transaction`). |

**Constraints:** Same as `create_transaction`. Transaction ID must exist.

**Side effects:** Same as `create_transaction` (updates memories and global settings).

**Example Request:**

```bash
curl -X POST https://api-finances-dev.marotta.dev/rpc/update_transaction \
-H "Content-Type: application/json" \
-H "Authorization: Bearer <jwt>" \
-d '{
  "p_id": "cf90d2e8-...",
  "p_date": "2026-03-08",
  "p_description": "Updated Description",
  "p_entries": [...]
}'
```

---

### `delete_transaction`

Deletes a transaction and all its entries (cascade).

**Endpoint:** `POST /rpc/delete_transaction`

**Arguments:**

| Name | Type | Description |
| :--- | :--- | :--- |
| `p_id` | `UUID` | The ID of the transaction to delete. |

**Response:** `true` if deleted, `false` if not found.

**Example Request:**

```bash
curl -X POST https://api-finances-dev.marotta.dev/rpc/delete_transaction \
-H "Content-Type: application/json" \
-H "Authorization: Bearer <jwt>" \
-d '{"p_id": "cf90d2e8-..."}'
```

---

### `match_description_memory`

Fuzzy-matches a description string against stored description memories. Used for autocomplete in quick entry.

**Endpoint:** `POST /rpc/match_description_memory`

**Arguments:**

| Name | Type | Description |
| :--- | :--- | :--- |
| `p_input` | `TEXT` | Text to match against stored descriptions. |

**Response:** Array of matching memory objects with suggested `category_id`, `account_id`, and `currency`.

---

### `match_account`

Fuzzy-matches a text string against account names. Used for autocomplete in quick entry.

**Endpoint:** `POST /rpc/match_account`

**Arguments:**

| Name | Type | Description |
| :--- | :--- | :--- |
| `p_input` | `TEXT` | Text to match against account names. |

**Response:** Array of matching account objects.

---

## Database Views

These views are exposed via PostgREST as read-only endpoints. All require `Authorization: Bearer <jwt>`.

---

### `account_balances`

Current balance for all accounts, derived from entries.

**Endpoint:** `GET /account_balances`

| Property | Type | Description |
| :--- | :--- | :--- |
| `account_id` | `UUID` | Account identifier. |
| `account_name` | `TEXT` | Hierarchical account name (e.g., `expenses:food`). |
| `account_type` | `TEXT` | One of: asset, liability, expense, income, equity. |
| `balance` | `NUMERIC` | `SUM(amount_base)` across all entries for this account. |

---

### `transactions_with_entries`

Transactions with their entries nested as a JSONB array. Primary endpoint for the ledger view.

**Endpoint:** `GET /transactions_with_entries`

| Property | Type | Description |
| :--- | :--- | :--- |
| `id` | `UUID` | Transaction identifier. |
| `date` | `DATE` | Transaction date. |
| `description` | `TEXT` | Transaction description. |
| `metadata` | `JSONB` | Optional metadata. |
| `entries` | `JSONB` | Array of entry objects (id, account_id, account_name, account_type, amount, currency, exchange_rate, amount_base). |

Supports PostgREST filtering and ordering, e.g. `?order=date.desc,created_at.desc`.

---

### `category_totals`

Sum of entries per expense and income category, filtered by date range.

**Endpoint:** `GET /category_totals`

| Property | Type | Description |
| :--- | :--- | :--- |
| `category_name` | `TEXT` | Hierarchical account name. |
| `category_type` | `TEXT` | `expense` or `income`. |
| `total` | `NUMERIC` | Sum in base currency. |

---

### `dashboard_data`

Flat stream of entries with hierarchical account names for frontend aggregation. Used by the Dashboard component.

**Endpoint:** `GET /dashboard_data`

Supports filtering by date: `?date=gte.2026-01-01&date=lte.2026-12-31`

---

### `daily_balances`

Daily cumulative balance snapshots per asset sub-type. Used for the Dashboard area chart.

**Endpoint:** `GET /daily_balances`

| Property | Type | Description |
| :--- | :--- | :--- |
| `date` | `DATE` | The date. |
| `checking` | `NUMERIC` | Balance of `assets:checking:*` accounts. |
| `emergency` | `NUMERIC` | Balance of `assets:emergency:*` accounts. |
| `investments` | `NUMERIC` | Balance of `assets:investments:*` accounts. |
| `credit_card` | `NUMERIC` | Balance of `liabilities:credit-card:*` accounts. |
| `total_assets` | `NUMERIC` | Sum of all asset balances. |

---

### `daily_account_balances`

Daily balance per individual account. Granular version of `daily_balances`.

**Endpoint:** `GET /daily_account_balances`

---

### `monthly_balances`

Monthly balance snapshots. Available but the frontend primarily uses `daily_balances`.

**Endpoint:** `GET /monthly_balances`

---

### `account_names_hierarchical`

Accounts with their full hierarchical name computed (e.g., `expenses:food:grocery`). Used internally by other views and RPCs.

**Endpoint:** `GET /account_names_hierarchical`

| Property | Type | Description |
| :--- | :--- | :--- |
| `id` | `UUID` | Account identifier. |
| `name` | `TEXT` | Leaf name only (e.g., `grocery`). |
| `full_name` | `TEXT` | Full path (e.g., `expenses:food:grocery`). |
| `type` | `TEXT` | Account type. |
| `parent_id` | `UUID` | Parent account identifier. |

---

### `account_usage`

Accounts ranked by how often they appear in entries. Used to suggest accounts in the UI.

**Endpoint:** `GET /account_usage`

| Property | Type | Description |
| :--- | :--- | :--- |
| `account_id` | `UUID` | Account identifier. |
| `account_name` | `TEXT` | Full hierarchical name. |
| `account_type` | `TEXT` | Account type. |
| `usage_count` | `BIGINT` | Number of entries referencing this account. |
| `last_used_at` | `TIMESTAMPTZ` | Most recent entry timestamp. |

---

### `description_memories_with_names`

Description memories joined with resolved account names. Used for quick-entry autocomplete.

**Endpoint:** `GET /description_memories_with_names`

| Property | Type | Description |
| :--- | :--- | :--- |
| `description` | `TEXT` | The remembered description. |
| `category_id` | `UUID` | Suggested category account ID. |
| `category_name` | `TEXT` | Suggested category full name. |
| `account_id` | `UUID` | Suggested source account ID. |
| `account_name` | `TEXT` | Suggested source account full name. |
| `currency` | `TEXT` | Last used currency for this description. |
| `usage_count` | `INTEGER` | How many times this description has been used. |
| `last_used_at` | `TIMESTAMPTZ` | When it was last used. |

---

## Budget Module

### `create_budget_plan`

Creates a new budget plan and sets it as the current plan (all other plans are set to `is_current = false`).

**Endpoint:** `POST /rpc/create_budget_plan`

**Arguments:**

| Name | Type | Description |
| :--- | :--- | :--- |
| `p_name` | `TEXT` | Plan name (e.g. "2026 Annual Budget"). |
| `p_period_start` | `DATE` | Budget period start date (YYYY-MM-DD). |
| `p_period_end` | `DATE` | Budget period end date (YYYY-MM-DD). |

**Response:** The created `budget_plans` row.

---

### `set_current_budget_plan`

Switches the active plan. Sets `is_current = true` for the given plan and `false` for all others.

**Endpoint:** `POST /rpc/set_current_budget_plan`

**Arguments:**

| Name | Type | Description |
| :--- | :--- | :--- |
| `p_plan_id` | `UUID` | The plan to make current. |

**Response:** `true` on success.

---

### `upsert_budget_item`

Inserts or updates a budget item for a `(plan_id, account_id)` pair. The account must be of type `expense`.

**Endpoint:** `POST /rpc/upsert_budget_item`

**Arguments:**

| Name | Type | Description |
| :--- | :--- | :--- |
| `p_plan_id` | `UUID` | Plan ID. |
| `p_account_id` | `UUID` | Expense account ID. |
| `p_period_amount` | `NUMERIC` | Total budget for the entire plan period. |
| `p_min_pct` | `NUMERIC` | Minimum monthly % of adjusted target (e.g. 60). |
| `p_max_pct` | `NUMERIC` | Maximum monthly % of adjusted target (e.g. 140). |
| `p_sort_order` | `INTEGER` | Display order within the plan (default `0`). |
| `p_category_type` | `TEXT` | `'yearly'` or `'monthly'` (default `'yearly'`). |

**Response:** The upserted `budget_items` row.

---

### `delete_budget_item`

Removes a budget item from a plan.

**Endpoint:** `POST /rpc/delete_budget_item`

**Arguments:**

| Name | Type | Description |
| :--- | :--- | :--- |
| `p_id` | `UUID` | Budget item ID to delete. |

**Response:** `true` if deleted, `false` if not found.

---

### `budget_items_with_accounts`

Budget items joined with their account's full hierarchical name, icon, and color. Primary endpoint for rendering the budget category list.

**Endpoint:** `GET /budget_items_with_accounts`

Supports filtering: `?plan_id=eq.<uuid>`

| Property | Type | Description |
| :--- | :--- | :--- |
| `id` | `UUID` | Budget item ID. |
| `plan_id` | `UUID` | Plan ID. |
| `account_id` | `UUID` | Account ID. |
| `account_full_name` | `TEXT` | Full hierarchical name (e.g. `expenses:food:grocery`). |
| `account_name` | `TEXT` | Leaf name only (e.g. `grocery`). |
| `icon` | `TEXT` | Account icon slug. |
| `color` | `TEXT` | Account color hex. |
| `parent_id` | `UUID` | Account parent ID (for hierarchy rendering). |
| `period_amount` | `NUMERIC` | Total period budget. |
| `min_pct` | `NUMERIC` | Minimum monthly %. |
| `max_pct` | `NUMERIC` | Maximum monthly %. |

---

### `budget_monthly_spending`

For each budget item, returns actual spending per calendar month within the plan period. Spending is rolled up from `entries.amount_base` for the item's account and all its descendant accounts.

**Endpoint:** `GET /budget_monthly_spending`

Supports filtering: `?plan_id=eq.<uuid>`

| Property | Type | Description |
| :--- | :--- | :--- |
| `plan_id` | `UUID` | Plan ID. |
| `account_id` | `UUID` | Budget item account ID. |
| `month` | `DATE` | First day of the month (e.g. `2026-01-01`). |
| `spent` | `NUMERIC` | Sum of `amount_base` for that account and descendants in that month. |

---

## Provenance, classification and reconciliation (migrations 0047–0051)

Added for the AI advisor (`docs/ADVISOR.md`). Everything below is plain PostgREST; the advisor daemon's
own HTTP API is documented in `advisor/README.md`.

### `create_transaction` / `update_transaction` — `p_metadata`

Both RPCs accept an optional fourth/fifth argument `p_metadata JSONB`. On create it is stored as
`transactions.metadata`; on update a JSON object is merged over the stored value (`NULL` keeps it).
Three-/four-argument callers keep working. The advisor writes:

```json
{ "source": "advisor", "plan_id": "…", "plan_item_id": "…", "statement_id": "…", "institution": "nubank",
  "fitid": "66f1…", "statement_line_hash": "sha256", "approved_by": "web",
  "statement_line": { "raw": "TAMPOPO ALIMENTOS LTDA", "posted_at": "2026-10-01T12:30:00-03:00", "fitid": "…", "hash": "…" } }
```

`metadata->>'fitid'` and `metadata->>'source'` are indexed. When `statement_line.raw` is present the RPC
teaches `merchant_aliases` (raw text → the description used).

### `classify_candidates`

Derived, multi-factor category suggestion (replaces stored description memories, §21 of ADVISOR.md).

**Endpoint:** `POST /rpc/classify_candidates`

| Name | Type | Description |
| :--- | :--- | :--- |
| `p_description` | `TEXT` | Proposed description or hint |
| `p_amount` | `NUMERIC` | Optional absolute amount |
| `p_account_id` | `UUID` | Optional asset/liability account |
| `p_date` | `DATE` | Optional date (weekday / day-of-month evidence) |
| `p_posted_at` | `TIMESTAMPTZ` | Optional posting time (hour evidence) |
| `p_raw` | `TEXT` | Optional raw statement text (alias short-circuit, raw similarity) |
| `p_limit` | `INT` | Default 5 |

**Response rows:** `category_id, category_name, category_type, canonical_description, account_id,
account_name, account_type, currency, score, confidence, n_matches, factors` (`factors` = per-factor
averages, `n_matches`, `last_seen`, `alias`, `same_amount_count`, `same_account_count`,
`modal_description`). Weights live in `global_settings.classifier_weights`.

`match_description_memory(p_input)` keeps its previous shape and is now a wrapper over this function;
`description_memories_with_names` is a derived view over `transaction_lines` with the same columns as
before (`description_memories` is no longer written).

### `merchant_aliases` (table), `normalize_merchant(text)`, `transaction_lines` (view)

`merchant_aliases(raw_normalized pk, canonical_description, account_id, source, hits)` maps
`normalize_merchant(raw statement text)` to the household's short name. `transaction_lines` exposes one
row per category entry with `norm_description`, `raw`, `norm_raw`, `posted_at`, `amount`,
`asset_account_id` and is the classifier's only input.

### Reconciliations

Tables `reconciliations` and `reconciliation_items` (see `docs/ADVISOR.md` §5.5). RPCs:

| RPC | Arguments | Notes |
| :--- | :--- | :--- |
| `open_reconciliation` | `p_account_id, p_period_start, p_period_end, p_statement_opening, p_statement_closing, p_currency?, p_statement_ref?, p_created_by?` | Computes `ledger_opening`/`ledger_closing`, checks continuity with the previous balanced period (`notes` gets `continuity_break: …`), inserts `open` |
| `set_reconciliation_items` | `p_id, p_items jsonb` | Replaces items `[{kind, entry_id?, statement_line_hash?, amount?, note?}]`, recomputes `cleared_total`, `outstanding_total`, `difference = statement_closing − (ledger_opening + cleared_total)` |
| `close_reconciliation` | `p_id, p_status, p_adjustment_transaction_id?, p_notes?` | `balanced` only when `|difference| < 0.005`; `adjusted` needs a transaction whose leg on the account equals the difference and whose other leg is on `ajustes`; sets `accounts.last_checked` |
| `reopen_reconciliation` | `p_id, p_notes?` | Back to `open` (used when a cleared entry is edited with consent) |
| `ledger_balance_as_of` | `p_account_id, p_date` | `SUM(amount_base)` up to a date |
| `uncleared_entries` | `p_account_id, p_through_date?, p_from_date?` | Entries not vouched by any reconciliation |

Views: `entry_clearings` (cleared entry → reconciliation), `account_reconciliation_status`
(`reconciled_through`, `last_status`, `open_difference`, `suspense_balance` per asset/liability account).
`account_balances` gained `reconciled_through` and `cleared_balance`; `transactions_with_entries` gained
`clearing` (`{reconciliation_id, period_end, account_id, statement_ref}` or null).

### `ajustes`

Root expense account seeded by 0049: the suspense account for reconciliation adjustments.
