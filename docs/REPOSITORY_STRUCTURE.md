# REPOSITORY_STRUCTURE.md

## Overview

This project follows a **Postgres-first architecture**.

The repository is organized around three main areas:

```
docs
database
application
```

The database is the source of truth for financial data.

---

# Root Structure

```
/
  docs/
  migrations/
  scripts/
  db/
  app/
```

---

# docs/

Project documentation used by developers and AI agents.

```
docs/
  ARCHITECTURE.md
  DOMAINS.md
  LEDGER_RULES.md
  PRODUCT.md
  MIGRATION_STRATEGY.md
```

These documents define the system behavior, domain model, and architecture.

---

# migrations/

Database migration files.

```
migrations/
  0001_init.sql
  0002_accounts.sql
  0003_transactions.sql
  0004_entries.sql
```

Rules:

- migrations run in alphabetical order
- each migration represents one schema change

---

# db/

Database SQL definitions.

```
db/
  functions/
  views/
```

### functions/

SQL functions exposed through PostgREST RPC.

Example:

```
create_transaction.sql
```

---

### views/

Database views used for reporting.

Examples:

```
account_balances.sql
category_breakdown.sql
```

---

# scripts/

Utility scripts used during development.

```
scripts/
  migrate.py
```

Responsibilities:

- run database migrations
- record migration versions
- trigger PostgREST schema reload

---

# app/

Frontend application.

```
app/
  components/
  hooks/
  lib/
  pages/
```

Typical structure:

```
app/
  components/
    ledger-table
    quick-entry

  hooks/
    useTransactions
    useAccounts

  lib/
    ledger-parser

  pages/
    ledger
    dashboard
```

The frontend communicates directly with PostgREST.

---

# Key Principles

```
Postgres is the source of truth
PostgREST exposes the API
React implements the UI
```

The database contains the financial logic.

The frontend focuses on user interaction.