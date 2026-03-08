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
