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
