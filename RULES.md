# RULES.md

## Purpose

This file defines rules for AI agents and developers working in this repository.

The goal is to keep the project:

- simple
- consistent
- easy to maintain

Agents must follow these rules when generating or modifying code.

---

# Documentation First

Before implementing any feature, read the documentation in:

```
docs/
```

Important documents:

```
PRODUCT.md
DOMAINS.md
LEDGER_RULES.md
ARCHITECTURE.md
```

If implementation conflicts with documentation, follow the documentation.

---

# Frontend Stack

The frontend must use:

```
React
TanStack Table
TanStack Query
shadcn/ui
TailwindCSS
```

Do not introduce additional UI frameworks.

---

# React Style

Use **functional components only**.

Prefer:

- small components
- readable code
- simple logic

Split large components when needed.

---

# State Management

Use a dedicated state library.

Allowed:

```
TanStack Query
Zustand
Jotai
```

Avoid relying only on React local state for application state.

---

# Styling

Styling uses:

```
TailwindCSS
shadcn/ui
```

Prefer simple Tailwind utilities.

Avoid introducing other styling systems.

---

# UI Principles

The interface must prioritize:

```
keyboard-first workflows
fast data entry
minimal friction
```

The system must be **faster than Excel for entering transactions**.

---

# Migrations

Database schema changes must use SQL migrations.

Location:

```
migrations/
```

Naming format:

```
0001_init.sql
0002_accounts.sql
0003_entries.sql
```

Migrations are executed via:

```
scripts/migrate.py
```

Never modify existing migrations.  
Create new ones instead.

---

# Commits

Commits must be descriptive.

Each commit must explain:

- what was implemented
- why it was implemented

Commit messages should be suitable for generating a changelog.

Example:

```
feat: implement quick entry parser for transaction input
fix: correct ledger grouping by date
refactor: simplify ledger table rendering
```

---

# Implementation Log

All work performed by AI agents must be recorded in:

```
IMPLEMENTATION_LOG.md
```

Each entry should describe:

- what was implemented
- files modified
- important decisions

This file acts as a development log.

---

# Pending Work Tracking

If a problem, missing feature, or architectural decision appears during development, it must be recorded in:

```
LEDGER.md
```

The entry should include:

- description of the issue
- possible approaches
- context

Agents should resolve items from `LEDGER.md` whenever possible.

---

# General Rule

Prefer the **simplest working solution**.

Avoid unnecessary complexity.