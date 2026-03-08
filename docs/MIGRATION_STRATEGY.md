# MIGRATION_STRATEGY.md

## Overview

The system uses **SQL-based migrations** to manage database schema changes.

Migrations are executed using a lightweight **Python migration runner**.

The migration system is intentionally simple and avoids heavy frameworks such as:

- Alembic
- Flyway
- Prisma
- Liquibase

The goal is to keep migrations:

- transparent
- versioned
- deterministic
- easy to run

---

# Migration Directory Structure

All migrations live in the `migrations/` directory.

Example:

```
migrations/

0001_init.sql
0002_accounts.sql
0003_transactions.sql
0004_entries.sql
```

Each migration file represents a **single atomic schema change**.

Migration files must be applied **in order**.

---

# Migration Version Tracking

The database stores applied migrations in a table.

```
schema_migrations
```

Schema:

```
version TEXT PRIMARY KEY
applied_at TIMESTAMP
```

Example:

```
version      applied_at
0001_init    2026-03-01
0002_accounts
0003_entries
```

---

# Migration Execution

A Python script runs migrations.

Location:

```
scripts/migrate.py
```

Responsibilities:

1. connect to Postgres
2. read migration files
3. check which migrations are already applied
4. run missing migrations
5. record applied migration
6. reload PostgREST schema

---

# Migration Order

Migration files are executed **alphabetically**.

Example:

```
0001_init.sql
0002_accounts.sql
0003_transactions.sql
0004_entries.sql
```

The numeric prefix ensures correct ordering.

---

# Migration File Rules

Migration files must follow these rules.

### One logical change per migration

Good:

```
0005_add_currency_columns.sql
```

Bad:

```
0005_random_changes.sql
```

---

### Migrations must be idempotent when possible

Use safe SQL patterns:

```
CREATE TABLE IF NOT EXISTS
ALTER TABLE ADD COLUMN IF NOT EXISTS
```

---

### Avoid destructive migrations

Avoid:

```
DROP TABLE
DROP COLUMN
```

Instead prefer:

```
soft migrations
data migration
```

---

# PostgREST Schema Reload

After running migrations, PostgREST must reload the schema cache.

This is done using PostgreSQL NOTIFY.

```
NOTIFY pgrst, 'reload schema';
```

The migration runner should execute this command after all migrations complete.

This allows PostgREST to immediately expose:

- new tables
- new views
- new functions
- new RPC endpoints

---

# Migration Runner Workflow

The migration runner performs the following steps.

```
connect to database
        ↓
ensure schema_migrations table exists
        ↓
read migration files
        ↓
check applied migrations
        ↓
execute missing migrations
        ↓
record migration version
        ↓
NOTIFY pgrst reload schema
```

---

# Transaction Safety

Each migration must run inside a database transaction.

```
BEGIN;
migration SQL
COMMIT;
```

If a migration fails:

```
ROLLBACK
```

The migration must not be recorded.

---

# Example Migration

Example file:

```
0003_entries.sql
```

Contents:

```
CREATE TABLE entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id),
  account_id UUID REFERENCES accounts(id),
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL,
  exchange_rate NUMERIC NOT NULL,
  amount_base NUMERIC NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);
```

---

# Development Workflow

Typical workflow:

```
1. create new migration
2. write SQL
3. run migration script
4. verify schema
5. commit migration file
```

Example:

```
0006_add_metadata_to_transactions.sql
```

---

# Production Deployment

Deployment process:

```
deploy code
run migrations
restart PostgREST (optional)
```

Because the migration runner triggers:

```
NOTIFY pgrst
```

PostgREST will reload its schema automatically.

---

# Why This Strategy

This migration approach is chosen because it is:

```
simple
transparent
Postgres-native
compatible with PostgREST
```

It avoids introducing unnecessary tooling while remaining fully production-ready.