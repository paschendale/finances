# Documentation

This directory contains the **design and architectural documentation** for the personal finance ledger system.

The documentation is structured to clearly separate:

- product behavior
- domain model
- accounting rules
- system architecture
- database migration strategy

AI agents implementing the system should read the documents **in the order below**.

---

# Reading Order

The recommended reading order is:

1. PRODUCT.md
2. DOMAINS.md
3. LEDGER_RULES.md
4. ARCHITECTURE.md
5. MIGRATION_STRATEGY.md

This order moves from **user behavior → domain model → implementation architecture**.

---

# Documents

## PRODUCT.md

Defines the **product behavior and user experience**.

This document describes:

- how users interact with the system
- the daily ledger interface
- quick entry input
- keyboard navigation
- smart defaults
- autocomplete behavior
- category handling
- transfer detection
- dashboard behavior
- multi-currency support

This document defines **what the system must do**.

---

## DOMAINS.md

Defines the **financial domain model**.

This includes:

- ledger accounting structure
- accounts
- transactions
- entries
- hierarchical categories
- split transactions
- multi-currency representation

This document defines **how financial data is structured**.

---

## LEDGER_RULES.md

Defines the **accounting invariants and rules** of the ledger.

Includes:

- double-entry balancing rules
- sign conventions
- income / expense flows
- transfer rules
- split transaction rules
- multi-currency rules
- append-only ledger philosophy

This document defines **how financial transactions must behave**.

---

## ARCHITECTURE.md

Defines the **system architecture**.

Stack overview:

```
React
TanStack Table
shadcn/ui
PostgREST
PostgreSQL
```

This document describes:

- responsibilities of each layer
- API exposure through PostgREST
- frontend responsibilities
- system design principles

---

## MIGRATION_STRATEGY.md

Defines the **database migration workflow**.

This includes:

- migration file structure
- migration version tracking
- Python migration runner
- PostgREST schema reload
- development workflow

---

## REPOSITORY_STRUCTURE.md

Defines the overall repository layout.

This document explains how the project is organized across:

```
docs/
migrations/
db/
scripts/
app/
```

It describes where to place:

- database migrations
- SQL functions and views
- migration scripts
- frontend code

This document helps ensure the implementation follows a **consistent project structure**.

---

## API_CONTRACT.md

Defines the **available API endpoints and RPC functions**.

This document describes:

- available RPC functions (e.g., `create_transaction`)
- available database views (e.g., `account_balances`)
- request and response schemas
- usage examples with `curl`

This document defines **how to interact with the system API**.

---

# Source of Truth

Each part of the system has a clear source of truth.

| Concern              | Source                  |
| -------------------- | ----------------------- |
| Product behavior     | PRODUCT.md              |
| Financial model      | DOMAINS.md              |
| Accounting rules     | LEDGER_RULES.md         |
| System architecture  | ARCHITECTURE.md         |
| Database evolution   | MIGRATION_STRATEGY.md   |
| Repository Structure | REPOSITORY_STRUCTURE.md |
| API Specification    | API_CONTRACT.md         |

---

# Implementation Notes

The system follows a **Postgres-first architecture**.

Key principles:

- PostgreSQL is the source of truth
- PostgREST exposes the database API
- the frontend interacts directly with PostgREST
- financial correctness is enforced by ledger rules

---

# Goal of the System

The system aims to provide a **fast, keyboard-driven financial ledger interface**.

The core usability goal is:

> Recording transactions must be faster than using Excel.
