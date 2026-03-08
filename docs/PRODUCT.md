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

Example:

```
padaria 18
uber 32
salario 8500 itau
```

While typing, the system shows a **preview of the resulting ledger transaction**.

Example preview:

```
Padaria

expenses:food     18
assets:nubank    -18
```

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

Each transaction can specify a currency.

Exchange rates are retrieved from:

```
https://api.frankfurter.dev
```

The exchange rate used is the **rate for the transaction date**.

The last used currency becomes the **default currency**.

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