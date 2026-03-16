# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Frontend (run from `app/`)
```bash
npm run dev        # Start dev server (http://localhost:5173)
npm run build      # TypeScript check + Vite build
npm run lint       # ESLint
npm run test       # Vitest
npm run preview    # Preview production build
```

### Database (Python, run from repo root)
```bash
python scripts/migrate.py              # Apply pending migrations
python scripts/seed.py                 # Populate test data
python scripts/reset_db.py             # Wipe and reset database
python scripts/set_jwt_secret.py       # Set JWT secret in DB
python scripts/generate_token.py 'Name' # Generate an auth token
```

### Environment setup
Copy `.env.example` to `.env` and provide:
- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — secret for JWT signing
- `VITE_APP_API_URL` — PostgREST endpoint URL

---

## Architecture

**Stack:** React 19 → PostgREST → PostgreSQL

The core design principle is **Postgres-first**: all financial logic lives in the database. PostgREST auto-generates the REST API from tables, views, and functions — there is no custom backend service. The frontend handles only rendering and UX.

### Data model (three tables)
- **accounts** — hierarchical ledger accounts (e.g., `expenses:food:grocery`), typed as asset/liability/expense/income/equity
- **transactions** — financial events with date and description
- **entries** — double-entry ledger lines linking a transaction to an account with amount, currency, exchange_rate, and amount_base

### Double-entry invariant
Every transaction must satisfy `SUM(entries.amount_base) = 0`. This is enforced in the database. Balances are never stored — they are always derived from entries.

Sign convention: positive = value flowing **into** an account, negative = value flowing **out**.

### API surface
All mutations go through RPC functions (not direct table writes):
- `POST /rpc/create_transaction`
- `POST /rpc/update_transaction`
- `POST /rpc/delete_transaction`
- `POST /rpc/login_with_token`

Views expose read-only data: `account_balances`, `transactions_with_entries`, `category_totals`, `dashboard_data`, `daily_balances`, etc.

### Authentication
Implemented entirely in Postgres. The user calls `login_with_token` with a plain-text token → DB verifies SHA-256 hash against `auth_tokens` table → returns a signed JWT. The frontend stores the JWT in `localStorage` under `finances_auth_token` and passes it as `Authorization: Bearer` on all requests. PostgREST switches the DB role to `authenticated` upon verification.

### Frontend structure (`app/src/`)
- `App.tsx` — root, view switching (Ledger vs Dashboard), auth gate
- `QuickEntryInput.tsx` — CLI-style transaction entry with live parsing and preview
- `LedgerTable.tsx` — main ledger view (inline editing, deletion, row expansion)
- `Dashboard.tsx` — financial overview with Recharts charts
- TanStack Query manages all server state; Zustand is available for client state.
- Path alias `@/*` maps to `app/src/*`.

### Migrations
SQL files in `migrations/` numbered `000N_description.sql`, executed alphabetically by `scripts/migrate.py`. The runner tracks applied versions in the `schema_migrations` table and calls `NOTIFY pgrst, 'reload schema'` after applying changes. **Never modify existing migration files** — always add a new one. Migrations must be idempotent (`CREATE TABLE IF NOT EXISTS`, etc.) and avoid destructive operations (`DROP TABLE`, `DROP COLUMN`).

---

## Rules and guidelines

- `RULES.md` — code style, state management, migration rules, commit format, TDD requirements
- `AI_GUIDELINES.md` — required workflow for AI agents (read docs → implement → log → record issues)
- `IMPLEMENTATION_LOG.md` — development log; **append an entry after every session**
- `LEDGER.md` — pending issues and unresolved decisions; consult and update as needed

## Documentation in `docs/`

Read these in order when working on new features:
1. `PRODUCT.md` — user-facing behavior, quick-entry format, keyboard navigation
2. `DESIGN_GUIDELINES.md` — Apple-style dark aesthetic, Geist font, spacing rules
3. `DOMAINS.md` — full domain model (accounts, transactions, entries, categories)
4. `LEDGER_RULES.md` — accounting invariants, sign conventions, multi-currency rules
5. `ARCHITECTURE.md` — system layers and design principles
6. `API_CONTRACT.md` — RPC schemas and view definitions with curl examples
