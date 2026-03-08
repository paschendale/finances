# IMPLEMENTATION_LOG.md

## 2026-03-08 - Initial Project Setup

### Tasks
- [x] Create project structure (`app/`, `db/`, `migrations/`, `scripts/`)
- [x] Implement migration runner (`scripts/migrate.py`)
- [x] Create initial migrations (`0001_init.sql`, `0002_accounts.sql`, `0003_transactions.sql`, `0004_entries.sql`)
- [x] Initialize React frontend in `app/` using Vite (React-TS)
- [x] Set up TailwindCSS v4 and shadcn/ui
- [x] Install frontend dependencies (`TanStack Table`, `TanStack Query`, `Zustand`)
- [x] Configure environment variables (`.env`, `.env.example`)
- [x] Track API deployment (`API_URL` in `.env`)

### Decisions
- Using Python `psycopg2` for the migration script as it's a standard for Postgres interaction in Python.
- Migrations follow the `XXXX_name.sql` pattern and are executed in alphabetical order.
- `amount_base` and `amount` use `NUMERIC` for precision.
- `id` uses `UUID` with `gen_random_uuid()`.
- Using TailwindCSS v4 with `@tailwindcss/vite` plugin.
- Path aliases configured as `@/` for `src/`.
- Deployment exposes `API_URL` for frontend consumption.

### Files Created/Modified
- `scripts/migrate.py`
- `migrations/0001_init.sql`
- `migrations/0002_accounts.sql`
- `migrations/0003_transactions.sql`
- `migrations/0004_entries.sql`
- `app/package.json`
- `app/vite.config.ts`
- `app/tsconfig.json`
- `app/src/index.css`
- `app/components.json`
- `app/src/lib/utils.ts`
- `app/src/components/ui/button.tsx`
- `.env.example`
- `.gitignore`

---

## 2026-03-08 - Database Seeding Implementation

### Tasks
- [x] Create database seed script (`scripts/seed.py`)
- [x] Implement hierarchical account creation logic
- [x] Generate 1,000 realistic transactions over 6 months
- [x] Implement multi-currency support (BRL/USD) with random exchange rates
- [x] Support for expenses, income, and transfers
- [x] Update `.gitignore` to include Python environment artifacts

### Decisions
- Using a standalone Python script for seeding to keep it separate from schema migrations.
- Implemented a recursive `get_or_create_account` function to handle hierarchical names like `expenses:food:grocery`.
- Hardcoded some fixed values (rent, internet) to make the generated data more realistic.
- Cross-currency transfers (BRL <-> USD) are handled by calculating `amount_base` correctly for both entries.
- Added `venv/` and `__pycache__/` to `.gitignore` as they are environment-specific.

### Files Created/Modified
- `scripts/seed.py`
- `.gitignore`

---

## 2026-03-08 - RPC Implementation: create_transaction

### Tasks
- [x] Create RPC function `create_transaction` in PL/pgSQL
- [x] Implement atomic transaction and entry creation
- [x] Add balance validation (SUM(amount_base) = 0)
- [x] Add entry count validation (minimum 2 entries)
- [x] Document RPC in `docs/API_CONTRACT.md`
- [x] Set up local Python virtual environment `.venv` for migrations
- [x] Verify implementation with successful and failing `curl` requests

### Decisions
- RPC function is written in PL/pgSQL to ensure atomicity within the database.
- The function returns the full transaction object including nested entries as JSONB, matching the expected frontend consumption pattern.
- Balance validation is strictly enforced within the RPC to prevent data corruption.
- Created `db/functions/create_transaction.sql` as a persistent reference for the function's source code, separate from migrations.
- Used `.venv` as the local virtual environment directory.

### Files Created/Modified
- `migrations/0005_create_transaction_rpc.sql`
- `db/functions/create_transaction.sql`
- `docs/API_CONTRACT.md`

---

## 2026-03-08 - Database Views: Account Balances, Transactions, and Categories

### Tasks
- [x] Create view `account_balances` for real-time account tracking
- [x] Create view `transactions_with_entries` for efficient frontend consumption
- [x] Create view `category_totals` for expense and income breakdown
- [x] Document new views in `docs/API_CONTRACT.md`
- [x] Apply changes through migration `0006_views.sql`
- [x] Create individual reference files in `db/views/`
- [x] Verify API responses using `curl`

### Decisions
- `transactions_with_entries` aggregates entries into a `jsonb` array to minimize API requests from the frontend.
- `category_totals` is filtered to only include `expense` and `income` account types to simplify dashboard implementation.
- `account_balances` uses a `LEFT JOIN` to ensure accounts with no entries still show a zero balance.
- All views are included in the same migration file (`0006_views.sql`) for simplicity during initial development.

### Files Created/Modified
- `migrations/0006_views.sql`
- `db/views/account_balances.sql`
- `db/views/transactions_with_entries.sql`
- `db/views/category_totals.sql`
- `docs/API_CONTRACT.md`
- `IMPLEMENTATION_LOG.md`

---

## 2026-03-08 - Quick Entry Parser Implementation

### Tasks
- [x] Install `vitest` for frontend testing
- [x] Implement `parseQuickEntry` in `app/src/lib/ledger-parser/`
- [x] Add comprehensive test suite using TDD
- [x] Support for simple expenses (`description amount`)
- [x] Support for transfers (`from > to amount`)
- [x] Support for income (`to < from amount`)
- [x] Support for date prefix (`YYYY-MM-DD ...`)
- [x] Support for Brazilian decimal format (comma)
- [x] Update `RULES.md` to include TDD guidelines

### Decisions
- Chose `app/src/lib/ledger-parser` as the location for the parser logic and tests.
- Implemented a regex-based parser for simplicity and speed.
- Defaulted unknown accounts to `expenses:unknown` or `assets:unknown` to be refined in the UI preview.
- Included support for optional date prefix to allow historical entries via quick entry.
- Added TDD requirement to `RULES.md` for logic-heavy parts of the system.

### Files Created/Modified
- `app/package.json`
- `app/src/lib/ledger-parser/parser.ts`
- `app/src/lib/ledger-parser/parser.test.ts`
- `RULES.md`
- `IMPLEMENTATION_LOG.md`
