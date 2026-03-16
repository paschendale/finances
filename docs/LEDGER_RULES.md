# LEDGER_RULES.md

## Purpose

This document defines the **core accounting rules** used by the system.

These rules must always hold true in the database and in all application logic.

The system uses a **double-entry ledger model**, meaning every financial transaction must be balanced.

---

# Core Ledger Rule

Every transaction must satisfy the invariant:

```
SUM(entries.amount_base) = 0
```

This rule guarantees that money cannot be created or destroyed accidentally.

If this rule is violated, the transaction must be rejected.

---

# Entry Sign Convention

Entries follow a strict sign convention.

Positive amounts represent **value flowing into an account**.

Negative amounts represent **value flowing out of an account**.

```
+ amount → money entering account
- amount → money leaving account
```

Example:

```
Padaria purchase

expenses:food      +18
assets:nubank      -18
```

---

# Expense Transactions

Expenses move value **from an asset account into an expense account**.

Example:

```
expenses:transport   +32
assets:nubank        -32
```

Result:

```
expenses increase
asset balance decreases
```

---

# Income Transactions

Income moves value **from an income account into an asset account**.

Example:

```
assets:itau        +8500
income:salary      -8500
```

Result:

```
asset balance increases
income increases
```

---

# Transfer Transactions

Transfers move value **between asset accounts**.

Example:

```
assets:itau     +500
assets:nubank   -500
```

Rules:

- transfers must involve **only asset accounts**
- no expense or income account is involved

---

# Split Transactions

Transactions may contain multiple category entries.

Example:

```
expenses:food:grocery      +80
expenses:home:cleaning     +20
assets:nubank             -100
```

Rules:

```
sum(category entries) = asset movement
```

Example validation:

```
80 + 20 = 100
```

---

# Multi-Currency Rules

Entries may be recorded in different currencies.

Each entry contains:

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
amount_base    converted value in base currency
```

Example:

```
expenses:food      +10 USD
assets:nubank      -10 USD
```

If:

```
1 USD = 5.20 BRL
```

Then:

```
amount_base = 52 BRL
```

Ledger balancing is always checked using:

```
amount_base
```

---

# Rounding Rules

Currency conversion may produce rounding differences.

Rules:

- `amount_base` should be stored using high precision numeric values
- rounding should only occur in UI presentation
- ledger validation uses raw stored values

---

# Account Type Constraints

Typical movement patterns:

```
Expense accounts → usually positive
Income accounts → usually negative
Asset accounts → can be positive or negative
```

These are conventions, not strict constraints.

The ledger model itself allows any balanced transaction.

---

# Edit and Delete

The system provides `update_transaction` and `delete_transaction` RPCs for correcting mistakes directly.

`update_transaction` atomically replaces all entries for a transaction and re-validates the balance invariant.

`delete_transaction` hard-deletes the transaction and cascades to its entries.

Both operations require the balance invariant to hold after the change.

---

# Derived Data Rule

The following values must **never be stored directly**:

```
account balances
monthly totals
category totals
dashboard metrics
```

They must always be derived from ledger entries.

Example balance query:

```
SELECT SUM(amount_base)
FROM entries
WHERE account_id = ?
```

---

# Transaction Atomicity

A transaction must be inserted **atomically**.

Rules:

- all entries must be inserted together
- partial transactions must never exist
- database transactions must be used

---

# Validation Checklist

Before committing a transaction, the system must ensure:

```
✓ at least two entries exist
✓ all entries reference valid accounts
✓ currencies are valid ISO codes
✓ exchange rate is present when currency != base currency
✓ SUM(entries.amount_base) = 0
```

If any validation fails, the transaction must be rejected.

---

# Design Philosophy

The ledger system prioritizes:

```
correctness
traceability
auditability
```

All financial state must be reconstructible from the ledger.

The ledger is the **single source of truth**.