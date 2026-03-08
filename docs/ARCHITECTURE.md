# ARCHITECTURE.md

## Overview

This system is a **personal finance ledger application** built using a **Postgres-first architecture**.

The database is the central component of the system and exposes its data through **PostgREST**, which automatically generates a REST API from the database schema.

The frontend consumes this API to display and manipulate ledger data.

The architecture prioritizes:

- simplicity
- minimal backend code
- strong data integrity
- fast development

---

# System Architecture

The system consists of three main layers.

```
React Frontend
      ↓
   PostgREST
      ↓
   PostgreSQL
```

Each layer has a clearly defined responsibility.

---

# Frontend

The frontend is responsible for:

- rendering the ledger
- providing fast data entry
- querying the API
- displaying derived financial data

Stack:

```
React
TanStack Table
TanStack Query
shadcn/ui
TailwindCSS
```

### Key responsibilities

Frontend handles:

- quick transaction entry
- ledger visualization
- filtering and sorting transactions
- grouping transactions by date
- inline editing

The frontend does **not implement financial logic**.

All financial logic is handled by the ledger model in the database.

---

# Backend

The backend consists of **PostgREST** exposing the PostgreSQL database as a REST API.

PostgREST automatically generates endpoints from database tables, views, and functions.

Examples:

```
/accounts
/transactions
/entries
/account_balances
```

Database functions can also be exposed as RPC endpoints.

Example:

```
/rpc/create_transaction
```

PostgREST removes the need for:

- controllers
- service layers
- ORM layers

The database becomes the **application backend**.

---

# Database

PostgreSQL is the **core of the system**.

It stores all financial data using a **ledger accounting model**.

The main tables are:

```
accounts
transactions
entries
```

The database is responsible for:

- data integrity
- enforcing ledger invariants
- exposing views for reporting
- executing transaction creation logic

All financial information is derived from ledger entries.

Balances are not stored.

---

# Data Flow

Typical transaction flow:

```
User input
    ↓
Frontend parses input
    ↓
Frontend calls PostgREST RPC
    ↓
Database creates transaction
    ↓
Ledger entries stored
    ↓
Frontend reloads ledger data
```

Example quick entry:

```
padaria 18
```

Frontend converts this into a ledger transaction and sends it to:

```
POST /rpc/create_transaction
```

---

# Design Principles

## Postgres-first

Business logic should live in the database whenever possible.

This includes:

- transaction creation
- ledger validation
- balance calculations

---

## Thin backend

The system intentionally avoids building a traditional backend service.

PostgREST replaces:

- REST controllers
- API frameworks
- ORM layers

---

## Derived financial state

Financial state is **never stored redundantly**.

Balances and reports are derived from ledger entries.

---

## Minimal architecture

The system intentionally avoids unnecessary complexity.

There are only three core layers:

```
UI
API
Database
```

---

# What is NOT included

The initial system intentionally excludes:

```
authentication
multi-user support
bank synchronization
receipt OCR
budgeting
notifications
```

These may be added later but are not required for the MVP.

---

# Future Architecture Extensions

Possible future additions include:

```
background workers
bank import pipelines
AI classification services
receipt processing
```

If these become necessary, an additional backend service may be introduced.

Example future architecture:

```
React
   ↓
PostgREST
   ↓
Worker Services
   ↓
PostgreSQL
```

However, the MVP architecture should remain **Postgres + PostgREST + React**.