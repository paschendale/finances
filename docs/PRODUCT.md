# PRODUCT.md

## Overview

This system is a **personal finance ledger application** designed for **fast manual entry of financial transactions**.

The primary design goal is:

**Recording finances must be faster than using Excel.**

The system is optimized for:

- fast batch entry
- keyboard-driven workflows
- minimal friction
- accurate financial tracking using a ledger model

The product is centered around a **daily ledger interface** with quick-entry capabilities.

---

# Core Interface

## Daily Ledger

The main interface is a **daily ledger view** where transactions are grouped by date.

Example:

```
3 Mar

Padaria           Nubank      -18
Uber              Nubank      -32

2 Mar

Mercado           Nubank     -120
```

Transactions are visually grouped by day.

The interface allows:

- adding new transactions
- editing existing transactions
- navigating between days
- reviewing past entries

---

# Transaction Display

Transactions show the **final financial effect**.

Fields displayed:

```
description
account
category
total value
```

### Category display

Categories come from ledger entries.

A transaction may contain **multiple expense categories**.

Example:

```
Supermarket purchase

expenses:food:grocery     80
expenses:home:cleaning    20
assets:nubank            -100
```

In the ledger view, categories are displayed using a **category chip**.

Display rule:

```
food +1
```

Meaning:

- the largest category is shown
- `+n` indicates additional categories

---

# Installments

Credit card purchases can be split into installments using the `amountxN` shorthand in Quick Entry, or by resuming a series mid-way with `(N de M)` in the description.

Example:

```
compra 120x12
```

Creates 12 independent transactions, one per month, each dated on the 1st of its target month. Series membership is identified purely by a description convention:

```
Compra (1 de 12)
Compra (2 de 12)
...
Compra (12 de 12)
```

There is no dedicated database schema for installment series — each installment is a normal transaction, and the ledger view groups them by matching this description pattern.

---

# Adiantar Parcela (Advance Installment)

Future installments can be pulled forward to an earlier date, optionally with a discount for early settlement (mirrors the "antecipar parcelas" feature offered by some credit cards).

A back-arrow-over-a-dot button appears next to the amount of any future installment. Clicking it opens a modal to:

- pick a new date (defaults to today, cannot be later than the installment's original date)
- enter a fixed discount amount (optional)
- pick an income category to book the discount against (required only when a discount is entered)

The original expense entry is left unchanged; the discount is recorded as a separate income entry, and the asset/liability entry is reduced by the discount amount. This keeps category and budget totals for the original purchase historically accurate, while the discount shows up as its own income line.

The date-only move works for any future installment, regardless of entry shape. The discount input is only enabled when the transaction has exactly one asset/liability entry (so there's an unambiguous account to credit the discount back into) — split-category installments are still supported as long as there's a single account being debited.

Advancing an installment also sweeps in any earlier, still-pending installments in the same series (e.g. anticipating 6 de 6 also pulls in 4 de 6 and 5 de 6 if they haven't happened yet) — you can't settle a later installment early while an earlier one is still sitting unpaid in the future. Swept installments move to the same new date at their full amount; the discount only applies to the installment you actually opened the modal on.

The discount itself is booked as a brand-new, separate income transaction — not an extra entry on the installment — dated the same as the new date, described as `Desconto - <original installment description>`, with two entries: the chosen income category (negative, "earned") and the installment's own asset/liability account (positive, crediting the discount back). The installment transaction itself is never altered beyond its date.

---

# Account Display

Account visualization depends on the transaction type.

### Expense / Income

Display the **receiving account**.

Example:

```
Padaria      Nubank     -18
```

---

### Transfers

Transfers are shown with both accounts.

Example:

```
Nubank → Itaú      500
```

Transfers are detected when the transaction moves money between asset accounts.

---

# Keyboard Navigation

The interface is fully keyboard-driven.

Key bindings:

```
ENTER        create new transaction
TAB          accept autocomplete
SHIFT + TAB  navigate to previous column
```

Users should be able to enter transactions **without using the mouse**.

---

# Smart Defaults

The system automatically applies defaults to reduce typing.

### Expense / Income detection

Transaction type is inferred from historical category usage.

Example:

```
food → expense
salary → income
```

Users can manually override the type if needed.

---

### Default account

The system assumes the user is entering transactions for the **last used account**.

Example:

```
last account used: Nubank
```

New entries will default to Nubank unless explicitly changed.

---

### Default currency

The system assumes the **last used currency** when inserting values.

---

# Quick Entry (CLI-style Input)

Transactions can be entered using a single-line command input.

Format:

```
description amount [CURRENCY] [ACCOUNT]
```

Examples:

```
padaria 18
uber 32
salario 8500 itau
passeios no mexico 470 USD
cafe 12 usd nubank
```

Currency codes are **case-insensitive** (`usd`, `USD`, `UsD` are all accepted) and normalized to uppercase.

While typing, the system shows a **preview of the resulting ledger transaction**.

Example preview for a foreign-currency transaction:

```
Passeios no Mexico

expenses:travel     470 USD  ≈ R$2,413.87
assets:nubank      -470 USD  ≈ R$2,413.87

1 USD = 5.1359 BRL
```

The exchange rate is fetched automatically from Frankfurter for the transaction date and displayed in the preview before the user confirms.

Users may edit the preview before confirming.

---

# Transfer Detection

Transfers are detected using a simple syntax:

```
account > account
```

Example:

```
nubank > itau 500
```

Preview:

```
assets:itau     500
assets:nubank  -500
```

---

# Autocomplete

Autocomplete assists users during entry.

### Word completion

When typing a word, the system attempts to match known descriptions.

Example:

```
pad
```

Matches:

```
padaria
```

Pressing `TAB` completes the word.

---

### Category suggestion

Categories are suggested using **regex-based matching** against previous descriptions.

Example:

```
uber → expenses:transport
padaria → expenses:food
```

This system does not use AI initially.

---

# Hierarchical Categories

Categories follow a hierarchical namespace format.

Example:

```
expenses:food:restaurant
expenses:food:grocery
expenses:transport:uber
```

Categories may have multiple levels.

Transactions may contain **multiple categories**.

Example:

```
food:grocery
home:cleaning
```

---

# Automatic Dashboard

The system provides an automatically generated dashboard based on ledger data.

The dashboard includes:

### Account balances

```
Nubank
Itaú
Cash
```

Balances are calculated directly from ledger entries.

---

### Expense breakdown

A **pie chart** showing expenses grouped by category.

Users can view breakdowns at different levels:

```
level 1 → expenses:food
level 2 → expenses:food:grocery
level 3 → expenses:food:grocery:organic
```

---

### Income breakdown

Pie chart showing income sources.

Example:

```
salary
freelance
```

---

### Date filters

Users can filter financial data by date.

Examples:

```
this month
last month
custom range
```

---

### Historical balances

Users can compute balances **up to a specific date**.

Example:

```
balance on 2025-12-31
```

---

# Multi-Currency Support

The system supports transactions in multiple currencies.

Each entry stores the original `amount` and `currency` alongside `exchange_rate` and `amount_base` (always in the base currency, BRL).

The **base currency** is configured in `global_settings` under the key `base_currency` (default: `BRL`). All balances and reports are derived from `amount_base`.

Exchange rates are retrieved automatically from:

```
https://api.frankfurter.dev/v2/rates?date=YYYY-MM-DD&base=USD&quotes=BRL
```

The rate used is the **rate for the transaction date**. For foreign-currency entries, the preview shows the live rate and converted value before the user confirms.

The last used currency becomes the **default currency** for subsequent entries.

---

# Hybrid Interface

The system offers two complementary interaction modes.

### Daily ledger

A chronological interface focused on quick entry and review.

---

### Table editor

A tabular interface allowing:

- inline editing
- sorting
- filtering
- bulk navigation

Both interfaces operate on the same ledger data.

---

# Performance Goal

The core usability requirement:

**Recording transactions must be faster than using Excel.**

This influences all design decisions.

The interface must prioritize:

- keyboard-first workflows
- minimal clicks
- smart defaults
- rapid entry