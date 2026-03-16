# DOMAINS.md

## Overview

This system manages personal finances using a **Ledger Accounting** model based on **double-entry bookkeeping**.

The goal is to maintain a **mathematically consistent financial ledger** while providing a **low-friction user interface** for entering expenses and income.

Users record financial events such as:

- expenses
- income
- transfers between accounts

Internally, all events are stored as **balanced ledger transactions**.

Every transaction must satisfy the invariant:

SUM(entries.amount_base) = 0

This ensures money is never created or destroyed accidentally.

---

# Core Concepts

## Ledger

The ledger is the **single source of truth** for all financial data.

It consists of three main entities:

```
accounts
transactions
entries
```

All balances and reports are derived from the ledger.

Balances must **never be stored directly**.

Balances are computed as:

```
SUM(entries.amount_base)
```

---

# Accounts

Accounts represent **containers of value or financial categories**.

Everything in the system is represented as an account.

Examples:

```
assets:nubank
assets:itau
expenses:food
expenses:transport
income:salary
```

Accounts represent:

- bank accounts
- cash
- expense categories
- income categories

Accounts have a **type** defining their role in the ledger.

Account types:

```
asset
liability
expense
income
equity
```

---

# Hierarchical Accounts

Accounts form a hierarchical namespace.

Example:

```
expenses
  food
    grocery
    restaurant
  transport
    uber
```

Account names follow a namespace pattern:

```
expenses:food:grocery
expenses:transport:uber
```

This allows aggregation at different levels:

```
expenses
expenses:food
expenses:food:grocery
```

---

# Transactions

A transaction represents a **financial event occurring at a specific date**.

Examples:

- buying food
- receiving salary
- transferring money between accounts

Transactions contain:

```
id
date
description
metadata
created_at
```

A transaction **does not store monetary values directly**.

Values are stored in entries.

---

# Entries

Entries represent **movements of value between accounts**.

Each transaction must contain **two or more entries**.

Example:

Buying food for 18 using Nubank:

```
Transaction: "Padaria"

entries:

expenses:food      +18
assets:nubank      -18
```

The sum must always equal zero.

```
18 + (-18) = 0
```

---

# Split Transactions (Multiple Categories)

Transactions may contain **multiple expense categories**.

Example:

```
Supermarket purchase

expenses:food:grocery      +80
expenses:home:cleaning     +20
assets:nubank             -100
```

This allows one transaction to be distributed across multiple categories.

The sum of category entries must equal the asset movement.

---

# Transfers

Transfers move money between asset accounts.

Example:

Transfer 500 from Nubank to Itaú.

```
Transaction: "Transfer"

entries:

assets:itau     +500
assets:nubank   -500
```

No expense or income accounts are involved.

Transfer detection is handled by the UI layer.

---

# Income

Income increases an asset account and decreases an income account.

Example:

```
Transaction: "Salary"

entries:

assets:itau     +8500
income:salary   -8500
```

---

# Expenses

Expenses increase an expense account and decrease an asset account.

Example:

```
Transaction: "Uber"

entries:

expenses:transport   +32
assets:nubank        -32
```

---

# Multi-Currency

The system supports transactions in multiple currencies.

Each entry stores:

```
amount
currency
exchange_rate
amount_base
```

Definitions:

```
amount         value in original currency
currency       ISO currency code (USD, BRL, EUR)
exchange_rate  conversion rate to base currency
amount_base    value converted to base currency
```

Example:

```
expenses:food      +10 USD
assets:nubank      -10 USD
```

With exchange rate:

```
1 USD = 5.20 BRL
```

Base values stored:

```
amount_base = 52 BRL
```

All balances are computed using:

```
amount_base
```

Exchange rates are retrieved from:

```
https://api.frankfurter.dev
```

using the transaction date.

---

# Balance Calculation

Balances are derived from ledger entries.

Example:

```
SELECT SUM(amount_base)
FROM entries
WHERE account_id = ?
```

For asset accounts:

```
balance > 0  → money available
balance < 0  → negative balance
```

---

# Personal Finance Model

Example account structure:

```
assets
  nubank
  itau
  cash

expenses
  food
    grocery
    restaurant
  transport
  rent
  entertainment

income
  salary
  freelance
```

---

# Data Model

## accounts

Represents ledger accounts.

Fields:

```
id
name
type
parent_id
created_at
```

Example rows:

```
assets:nubank
assets:itau
expenses:food:grocery
income:salary
```

---

## transactions

Represents financial events.

Fields:

```
id
date
description
metadata
created_at
```

Example:

```
2026-03-03
Padaria
```

Metadata is flexible JSON used for additional information.

Example:

```
{
  "source": "quick_entry",
  "confidence": 0.95
}
```

---

## entries

Represents value movements inside transactions.

Fields:

```
id
transaction_id
account_id
amount
currency
exchange_rate
amount_base
created_at
```

Example entries:

```
expenses:food      +18 BRL
assets:nubank      -18 BRL
```

---

## description_memories

Stores learned associations between transaction descriptions and their typical category/account/currency. Updated automatically by `create_transaction` and `update_transaction`.

Fields:

```
description
category_id         → FK to accounts (expense or income account)
account_id          → FK to accounts (asset or liability account)
currency            → last used currency for this description
updated_at
usage_count
last_used_at
normalized_description   → trigram-indexed form for fuzzy matching
```

---

## global_settings

Key-value store for app-wide defaults. Currently tracks `last_used_account_id` and `last_used_currency`, updated on every transaction mutation.

Fields:

```
key
value
updated_at
```

---

## account_aliases

Maps alias strings to accounts. Used for flexible account resolution during import and quick entry.

Fields:

```
alias
account_id
```

---

# Invariants

The following rules must always hold.

### Transaction balance

```
SUM(entries.amount_base) = 0
```

for every transaction.

---

### Entries belong to transactions

Every entry must reference a valid transaction.

---

### Entries reference accounts

Every entry must reference a valid account.

---

# Derived Data

The following information must **never be stored**, only computed.

Examples:

```
account balances
monthly expenses
cash flow
category breakdowns
```

All of these must be derived from ledger entries.

---

# Example Ledger

Example data:

Transaction:

```
2026-03-03 Padaria
```

Entries:

```
expenses:food 18
assets:nubank -18
```

Transaction:

```
2026-03-05 Salary
```

Entries:

```
assets:itau 8500
income:salary -8500
```

Balances become:

```
assets:nubank -18
assets:itau 8500
expenses:food 18
income:salary -8500
```

---

# Design Philosophy

The system follows these principles.

### Ledger as source of truth

All financial information must be derived from the ledger.

---

### Edit and delete

The system provides `update_transaction` and `delete_transaction` RPCs for correcting mistakes. Both enforce the balance invariant. This is a pragmatic product decision for a personal finance tool; auditing and immutability are not requirements.

---

### Simplicity

The data model is intentionally minimal.

Core tables:

```
accounts
transactions
entries
```

Everything else is derived.

---

# Future Extensions

Possible future additions include:

```
tags
receipts
bank imports
recurring transactions
AI classification
budgeting
```

These features must **not break the ledger accounting model**.
