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
- [x] Track API deployment (`VITE_APP_API_URL` in `.env`)

### Decisions
- Using Python `psycopg2` for the migration script as it's a standard for Postgres interaction in Python.
- Migrations follow the `XXXX_name.sql` pattern and are executed in alphabetical order.
- `amount_base` and `amount` use `NUMERIC` for precision.
- `id` uses `UUID` with `gen_random_uuid()`.
- Using TailwindCSS v4 with `@tailwindcss/vite` plugin.
- Path aliases configured as `@/` for `src/`.
- Deployment exposes `VITE_APP_API_URL` for frontend consumption.

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

---

## 2026-03-08 - QuickEntryInput Implementation & Environment Fix

### Tasks
- [x] Create API client (`app/src/lib/api.ts`) for accounts and transactions
- [x] Implement `QuickEntryInput` component with TDD-based parser integration
- [x] Implement Tab autocomplete for account names
- [x] Implement transaction preview with real-time feedback
- [x] Configure dark mode as the default theme
- [x] Set up TanStack Query in `App.tsx`
- [x] Fix environment variable loading by renaming `API_URL` to `VITE_APP_API_URL`
- [x] Configure Vite to load `.env` from project root (`envDir: ".."`)
- [x] Fix TypeScript interface imports using `import type` to prevent runtime errors

### Decisions
- Using `fetch` for API calls to keep dependencies minimal.
- Autocomplete uses a simple `includes` match on the account names fetched from the database.
- The UI is designed for a keyboard-first experience, with `Enter` to confirm and `Tab` to autocomplete.
- Dark mode is enforced via the `.dark` class in `App.tsx`.
- Defaulted currency to `BRL` for quick entry, as most entries will be in the local currency.
- Moved `.env` loading to the root level to centralize configuration for both scripts and frontend.

### Files Created/Modified
- `app/src/lib/api.ts`
- `app/src/components/QuickEntryInput.tsx`
- `app/src/App.tsx`
- `app/vite.config.ts`
- `.env`
- `.env.example`
- `IMPLEMENTATION_LOG.md`

---

## 2026-03-08 - LedgerTable & Apple-style UI Implementation

### Tasks
- [x] Implement `LedgerTable` with compact, high-density layout
- [x] Integrate `useInfiniteQuery` for infinite scroll support
- [x] Add "Apple-style" interactive expansion for transaction details
- [x] Implement sticky date headers with backdrop-blur
- [x] Color-code transaction values (Red for expenses, Green for income)
- [x] Display full hierarchical categories and account names
- [x] Add `scroll-smooth` and refined tactile hover/active states
- [x] Enhance `api.ts` with pagination support and improved TypeScript interfaces

### Decisions
- Switched from a table-based model to a flattened list of headers and transaction rows for better flexibility and design control.
- Used a responsive grid (`grid-cols-[1.5fr_1fr_1fr_120px]`) to ensure alignment across different screen sizes while maintaining a compact feel.
- Chose `max-h-96` and `opacity` transitions for the expansion effect to ensure it feels smooth and "native".
- Enforced a `BRL` default but supported multi-currency formatting via `Intl.NumberFormat`.
- Categorized transactions into `expense`, `income`, and `transfer` types to drive the visual logic (colors and prefixes).

### Files Created/Modified
- `app/src/components/LedgerTable.tsx`
- `app/src/App.tsx`
- `app/src/lib/api.ts`
- `app/src/index.css`
- `IMPLEMENTATION_LOG.md`

---

## 2026-03-08 - Refined QuickEntryInput & Apple-style UX

### Tasks
- [x] Refine `QuickEntryInput` with Apple-style compact design and glassmorphism
- [x] Implement `SearchableSelect` for keyboard-first account and category selection
- [x] Add "Context Bar" for Date and Account selectors with high visibility
- [x] Implement "Smart Defaults" based on top 10 most-used categories
- [x] Enable editable previews for description, amount, category, and account
- [x] Fix `z-index` and clipping issues for dropdowns over sticky headers
- [x] Optimize backend interaction with `fetchCategoryUsage` to leverage `category_totals` view
- [x] Improve parser to support explicit category/account in transfer/income syntax
- [x] Clean up unused imports in `LedgerTable.tsx` to ensure clean build

### Decisions
- Used `z-index` stacking hierarchy (`z-100` for main container, `z-30` for context bar, `z-20` for input, `z-10` for preview) to handle overlapping dropdowns and sticky headers correctly.
- Removed `overflow-hidden` from staging containers to allow absolute-positioned dropdowns to "escape" and remain visible.
- Implemented a dynamic `z-index` toggle in `SearchableSelect` to boost priority when open.
- Chose to show the top 10 categories by default to minimize typing, falling back to a full searchable list when typing starts.
- Prevented automatic `Enter` submission if the preview has been manually edited, ensuring user intent is captured via a explicit "Confirm" button.
- Defaulted the preview category to the most-used category if no history or parser match is found, reducing "unknown" results.

### Files Created/Modified
- `app/src/components/QuickEntryInput.tsx`
- `app/src/lib/api.ts`
- `app/src/lib/ledger-parser/parser.ts`
- `app/src/lib/ledger-parser/parser.test.ts`
- `app/src/components/LedgerTable.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-03-08 - Parser Refinement & Enhanced Transfer UX

### Tasks
- [x] Implement robust token-based parser in `parser.ts` following strict implicit rules
- [x] Add 35 comprehensive test cases to `parser.test.ts` covering all edge cases
- [x] Enhance `QuickEntryInput` to handle new `ParsedInput` structure (Transfer vs Expense)
- [x] Implement intelligent account mapping to resolve shorthands (e.g., "nubank" -> "assets:nubank")
- [x] Add interactive "Parsing Rules" tooltip for user guidance
- [x] Implement directional icons (`ArrowDownLeft`, `ArrowUpRight`) for transfer feedback
- [x] Add contextual labels ("Source Account", "Destination Account") in the staging area
- [x] Refine amount input in preview with dedicated labels and improved spacing
- [x] Ensure `z-index` and stacking priority for nested preview entries

### Decisions
- Adopted a "last numeric token" rule for the parser to allow numbers within descriptions (e.g., "pizza 4 queijos 70").
- Moved account resolution to the UI layer where the full account list is available, allowing the parser to remain "dumb" and fast.
- Used distinct icons for transfers to provide immediate visual confirmation of money flow direction.
- Prevented automatic submission of edited previews to ensure users verify manual changes.
- Integrated `ParserContext` into the parser to support smart defaults based on the current UI state (selected account/date).

---

## 2026-03-08 - Smart Defaults System Implementation

### Tasks
- [x] Create migration `0007_smart_defaults.sql` with `description_memories` and `global_settings` tables
- [x] Update `create_transaction` RPC in `0008_update_create_transaction_rpc.sql` to automatically learn from new transactions
- [x] Add heuristic in RPC to identify "category" (expense/income) and "account" (asset/liability)
- [x] Implement persistent storage for `last_used_account` and `last_used_currency`
- [x] Create view `description_memories_with_names` for efficient frontend fetching
- [x] Update `app/src/lib/api.ts` with new fetch functions
- [x] Refactor `QuickEntryInput.tsx` to use the new smart defaults system instead of local memory heuristics
- [x] Ensure automatic cache invalidation of memories after successful transaction submission
- [x] Cleanup unused imports and verify build

### Decisions
- Chose to handle memory updates directly in the `create_transaction` PL/pgSQL function to ensure atomicity and reduce API roundtrips.
- Implemented a heuristic in SQL to distinguish between categories and accounts based on account types (`expense`/`income` vs others).
- `global_settings` stores the last used asset account and currency globally, while `description_memories` provides fine-grained defaults per description.
- Replaced the previous `useMemo`-based history mapping in the frontend with a robust database-backed system.
- Default currency now flows from `global_settings` instead of being hardcoded to `BRL`.

### Files Created/Modified
- `migrations/0007_smart_defaults.sql`
- `migrations/0008_update_create_transaction_rpc.sql`
- `migrations/0009_fix_ambiguous_params.sql`
- `migrations/0010_fix_api_compatibility.sql`
- `db/functions/create_transaction.sql` (updated reference)
- `app/src/lib/api.ts`
- `app/src/components/QuickEntryInput.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-03-08 - API Compatibility Fix

### Tasks
- [x] Create migration `0010_fix_api_compatibility.sql` to restore original parameter names
- [x] Revert `p_*` prefix to maintain compatibility with existing frontend/curl requests
- [x] Resolve column/parameter ambiguity using function name prefix (e.g., `create_transaction.date`)
- [x] Update reference SQL file in `db/functions/`

### Decisions
- Restored original parameter names (`date`, `description`, `entries`) because PostgREST uses them as JSON keys in RPC calls.
- Switched to using `create_transaction.<param_name>` inside the PL/pgSQL function to disambiguate from table columns.

---

## 2026-03-08 - Strict Ordering & Smart Defaults Refinement

### Tasks
- [x] Update `transactions_with_entries` view to drop and recreate with strict `created_at DESC` ordering
- [x] Ensure entries within a transaction are also ordered by `created_at DESC`
- [x] Update `description_memories_with_names` to use hierarchical paths and order by `updated_at DESC`
- [x] Update `fetchTransactions` API to order by `date.desc, created_at.desc`
- [x] Update `fetchDescriptionMemories` API to explicitly request `updated_at.desc` ordering
- [x] Verify `QuickEntryInput` and `LedgerTable` correctly consume the new ordered data

### Decisions
- Standardized on `created_at DESC` across all levels (transactions and entries) to ensure the most recent items are always at the top, even when they share the same date.
- Dropped the `transactions_with_entries` view before recreating it to avoid Postgres "cannot change name of view column" errors when adding or reordering columns.
- Explicitly requested ordering in API calls even when views have a default `ORDER BY`, ensuring robustness against view changes.

### Files Created/Modified
- `migrations/0014_fix_ordering_and_smart_defaults.sql`
- `app/src/lib/api.ts`
- `IMPLEMENTATION_LOG.md`

