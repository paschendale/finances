# API Contract

This document defines the RPC functions and API endpoints available in the system.

## Database RPC Functions

These functions are exposed via PostgREST at `/rpc/<function_name>`.

### `create_transaction`

Creates a new transaction along with its associated entries in a single atomic operation.

**Endpoint:** `POST /rpc/create_transaction`

**Arguments:**

| Name | Type | Description |
| :--- | :--- | :--- |
| `date` | `DATE` | The date of the transaction (YYYY-MM-DD). |
| `description` | `TEXT` | A human-readable description of the transaction. |
| `entries` | `JSONB` | An array of entry objects. |

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
- The sum of all `amount_base` in `entries` must be exactly `0.00`.
- All `account_id` must exist.

**Example Request:**

```bash
curl -X POST https://api-finances-dev.marotta.dev/rpc/create_transaction \
-H "Content-Type: application/json" \
-d '{
  "date": "2026-03-08",
  "description": "Test Salary Income",
  "entries": [
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

**Success Response (200 OK):**

Returns the created transaction object with nested entries.

```json
{
  "id": "cf90d2e8-9e56-4a67-95ae-e66b9f1a1d8d",
  "date": "2026-03-08",
  "description": "Test Salary Income",
  "entries": [
    {
      "id": "...",
      "amount": 5000.00,
      "currency": "BRL",
      "account_id": "...",
      "amount_base": 5000.00,
      "exchange_rate": 1.0,
      "transaction_id": "..."
    },
    {
      "id": "...",
      "amount": -5000.00,
      "currency": "BRL",
      "account_id": "...",
      "amount_base": -5000.00,
      "exchange_rate": 1.0,
      "transaction_id": "..."
    }
  ]
}
```

**Error Response (400 Bad Request / 500 Internal Server Error):**

```json
{
  "code": "P0001",
  "message": "Transaction is not balanced: SUM(amount_base) = 50.00",
  "details": null,
  "hint": null
}
```

## Database Views

These views are exposed via PostgREST as read-only endpoints.

### `account_balances`

Returns the current balance for all accounts.

**Endpoint:** `GET /account_balances`

**Response Schema:**

| Property | Type | Description |
| :--- | :--- | :--- |
| `account_id` | `UUID` | Unique identifier of the account. |
| `account_name` | `TEXT` | Name of the account. |
| `account_type` | `TEXT` | Type of account (asset, liability, expense, income, equity). |
| `balance` | `NUMERIC` | Current balance in base currency. |

**Example Request:**

```bash
curl -s https://api-finances-dev.marotta.dev/account_balances
```

---

### `transactions_with_entries`

Returns a list of transactions with their associated entries nested as a JSON array.

**Endpoint:** `GET /transactions_with_entries`

**Response Schema:**

| Property | Type | Description |
| :--- | :--- | :--- |
| `id` | `UUID` | Unique identifier of the transaction. |
| `date` | `DATE` | Date of the transaction (YYYY-MM-DD). |
| `description` | `TEXT` | Transaction description. |
| `metadata` | `JSONB` | Additional metadata. |
| `entries` | `JSONB` | Array of entry objects. |

**Entry Object:**

| Property | Type | Description |
| :--- | :--- | :--- |
| `id` | `UUID` | Unique identifier of the entry. |
| `account_id` | `UUID` | ID of the account. |
| `account_name` | `TEXT` | Name of the account. |
| `account_type` | `TEXT` | Type of account. |
| `amount` | `NUMERIC` | Amount in original currency. |
| `currency` | `TEXT` | ISO currency code. |
| `exchange_rate`| `NUMERIC` | Conversion rate used. |
| `amount_base` | `NUMERIC` | Amount in base currency. |

**Example Request:**

```bash
curl -s https://api-finances-dev.marotta.dev/transactions_with_entries
```

---

### `category_totals`

Returns the total sum of entries for each expense and income category.

**Endpoint:** `GET /category_totals`

**Response Schema:**

| Property | Type | Description |
| :--- | :--- | :--- |
| `category_name` | `TEXT` | Name of the category (account name). |
| `category_type` | `TEXT` | Type of category (expense or income). |
| `total` | `NUMERIC` | Total sum in base currency. |

**Example Request:**

```bash
curl -s https://api-finances-dev.marotta.dev/category_totals
```
