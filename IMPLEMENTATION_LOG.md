# IMPLEMENTATION_LOG.md

## 2026-03-19 - Account Subtype Column + Flatten Remaining Containers

### Tasks
- [x] **Migration 0035** — Added `subtype` column to `accounts` (`checking`, `emergency`, `investments`, `liabilities`, `category`). Backfilled subtypes from parent account names, promoted all children of the 4 container accounts to root, deleted container accounts (`checking`, `emergency`, `investments`, `credit-card`). Account count: 133 → 129.
- [x] **View: account_balances** — Rebuilt to expose `subtype` column via a JOIN on `accounts`.
- [x] **View: daily_balances** — Replaced path-pattern CASE expressions with direct `a.subtype` column reference. `'credit-card'` category renamed to `'liabilities'`.
- [x] **API: Account / AccountNode** — Added `subtype: string | null` to both interfaces. `fetchAccountsTree`, `updateAccount`, `createAccount` updated to pass subtype.
- [x] **Dashboard: accountGroups** — Now filters by `a.subtype` instead of hardcoded path prefixes (was broken after migration 0034). Balance cards now show correct non-zero values.
- [x] **Dashboard: targetTypes / netWorth** — Updated `'credit-card'` → `'liabilities'` throughout. BalanceCard renamed "Credit Cards" → "Liabilities".
- [x] **AccountsPage: AccountModal** — Added subtype picker row (visible only for `type === 'asset'`). Auto-sets subtype when switching type. Subtype included in create/update payloads.

### Decisions
- Subtype is metadata on leaf accounts, not a hierarchy level — containers were pure structure with no accounting value.
- `liabilities` is the canonical subtype name for liability accounts (replaces `credit-card` which was a container name leaking into the view layer).
- The subtype picker for assets shows `[ — ] [ Checking ] [ Emergency ] [ Investments ]`; for other types it is hidden and set automatically.

### Files Created/Modified
- `migrations/0035_account_subtype.sql` (new)
- `db/views/daily_balances.sql`
- `app/src/lib/api.ts`
- `app/src/components/Dashboard.tsx`
- `app/src/components/AccountsPage.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-03-18 - Improved Account Visualization on Accounts Page

### Tasks
- [x] **Database View: account_balances** — Refactored to include hierarchical balances (rolling up sub-accounts), `own_balance` (account-only), `last_entry_date` (most recent transaction date in the hierarchy), and `parent_id`.
- [x] **API Contract: Account & AccountNode** — Updated TypeScript interfaces to include the new fields.
- [x] **AccountsPage: "All" Tab** — Added an "All" tab to view all accounts regardless of type, including a total count.
- [x] **AccountsPage: Card Enhancements** — Updated account cards to display the hierarchical balance and the last transaction date.
- [x] **AccountsPage: Layout** — Refined card layout to be more compact and include balance/date information in an Apple-style aesthetic.
- [x] **AccountsPage: Sort controls** — Added sort bar (Name / Balance / Last entry, asc/desc) between the type tabs and the card grid.
- [x] **Dashboard: Double-counting Fix** — Updated Dashboard calculations to use `own_balance` instead of hierarchical `balance` to ensure totals remain correct when parent and child accounts are filtered together.

### Decisions
- Chose to maintain both `balance` (hierarchical) and `own_balance` (non-hierarchical) to support different UI needs without extra complexity.
- Flipped signs for Income and Liability accounts in the AccountsPage UI to present "positive" values for natural states (income earned, debt owed) while using color-coding to indicate financial impact.
- Used `pt-BR` locale and `BRL` currency as the default for formatting on the account cards.
- Balance sort uses the same display-sign convention so the visual order matches what is shown on each card.

### Files Created/Modified
- `migrations/0032_account_balance_improvements.sql` (new)
- `app/src/lib/api.ts`
- `app/src/components/AccountsPage.tsx`
- `app/src/components/Dashboard.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-03-18 - Improved Income/Expense Detection and Modification

### Tasks
- [x] **QuickEntryInput: Manual Overrides** — Added a `toggleAllSigns` function to flip all entry signs in the staging area, allowing users to manually switch between income and expense classification. Added a "Toggle Sign" button to the UI.
- [x] **QuickEntryInput: Labeling Logic** — Refined the labeling and icon logic in the staging area to correctly identify 'Category' (Tag icon) and 'Account' (Wallet icon) based on their index and transaction type, regardless of the sign. This ensures refunds (negative expenses) are labeled correctly as 'Category' but with an 'income' badge.
- [x] **QuickEntryInput: Visual Feedback** — Improved the color logic in the staging area to color both category and account entries based on the detected transaction type (Red for Expense, Green for Income, Neutral for Transfer).
- [x] **LedgerTable: Correct Primary Type** — Updated the `primaryType` calculation in `allTransactionItems` and `ledgerItems` memos to correctly identify refunds (negative expenses) as income and reversals (positive income) as expenses. This ensures correct color and sign representation in the list view.
- [x] **LedgerTable: Stable Edit Type** — Refined the `editType` derivation in `TransactionRow` to check the sign of the entries, not just the account type. This ensures the color correctly updates when signs are toggled or values are modified during editing.
- [x] **LedgerTable: Transfer amount fix** — Restored positive-only asset entry summation for transfer display amount; `Math.abs(assetSum)` was always 0 for balanced transfers.

### Decisions
- Re-centered the "source of truth" for income/expense classification on the Asset-flow direction rather than just the presence of a specific account type.
- Used a uniform coloring scheme for entries within the editing view (entire transaction colored Red or Green) to provide high-signal feedback to the user about what kind of transaction they are creating/editing.
- Chose to maintain the 'Category' label for any entry in an expense/income account, even if the amount is negative (refund), while adding a specific 'income' badge for clarity.

### Files Modified
- `app/src/components/QuickEntryInput.tsx`
- `app/src/components/LedgerTable.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-03-18 - Persist Last Manual Entry Date & Account

### Tasks
- [x] `app/src/components/QuickEntryInput.tsx` — `selectedDate` initialized via lazy `useState` that reads `quick_entry_last` from localStorage, falling back to today
- [x] `app/src/components/QuickEntryInput.tsx` — Account defaulting `useEffect` checks localStorage first, validates saved account still exists and isn't hidden, then falls back to `lastUsedAccount` from global settings; added `accounts` as dependency
- [x] `app/src/components/QuickEntryInput.tsx` — `confirmTransaction` detects transfers via `parseQuickEntry(input).type === 'transfer'` and saves `{ date, account }` to `quick_entry_last` only for non-transfers, in both the installments and single-tx branches

### Decisions
- Pure frontend localStorage solution — no migrations or RPC changes needed. This is a UI preference, not financial data.
- Transfer detection is done client-side at point of confirmation so the logic stays simple.
- Save happens synchronously before the mutation (or after `Promise.all` for installments) so the correct values are captured at confirmation time.
- Fallback chain: localStorage saved account → global settings `last_used_account_id` → most recent transaction's asset account → first available asset/liability account.

### Files Modified
- `app/src/components/QuickEntryInput.tsx`

---

## 2026-03-17 - Export Wizard (CSV/XLSX Download)

### Tasks
- [x] `app/src/components/ExportWizard.tsx` — New modal with account filter, date range pickers, CSV/XLSX format toggle, and preview table (up to 50 entries with full `l1:l2:l3` hierarchy)
- [x] `app/src/lib/api.ts` — `fetchTransactionsForExport` (no pagination, full result set)
- [x] `app/src/components/LedgerTable.tsx` — Export button in toolbar pre-populates current ledger filters when opening the wizard
- [x] Added `xlsx` dependency to `app/package.json`

### Decisions
- Filename includes the exported date range (`export_YYYY-MM-DD_YYYY-MM-DD.{ext}`) for easy filing.
- Preview capped at 50 rows to keep the modal snappy; full export is unbounded.
- Format toggle (CSV/XLSX) is in the wizard so the user can switch without reopening.

### Files Created/Modified
- `app/src/components/ExportWizard.tsx` (new)
- `app/src/lib/api.ts`
- `app/src/components/LedgerTable.tsx`
- `app/package.json`

---

## 2026-03-17 - Description Search Filter in Ledger

### Tasks
- [x] `app/src/components/LedgerFilterBar.tsx` — Added text input for description substring search
- [x] `app/src/lib/api.ts` — `fetchTransactions` now accepts `desc` param, passed as PostgREST `ilike` filter
- [x] `app/src/App.tsx` — `desc` filter state threaded through to LedgerTable
- [x] URL persistence — `?desc=` query param added alongside existing filters

### Decisions
- Used PostgREST `ilike` for case-insensitive server-side filtering rather than client-side filtering to keep large datasets performant.
- State lives in the URL so filter is preserved on page reload and shareable.

### Files Modified
- `app/src/components/LedgerFilterBar.tsx`
- `app/src/components/LedgerTable.tsx`
- `app/src/lib/api.ts`
- `app/src/App.tsx`

---

## 2026-03-17 - Account Create, Type/Parent Editing & Hidden Flag

### Tasks
- [x] `migrations/0031_account_hidden.sql` — `hidden BOOLEAN DEFAULT FALSE` column on `accounts`; rebuilt `account_names_hierarchical`, `account_balances`, `account_usage` views to expose the flag
- [x] `app/src/components/AccountsPage.tsx` — `EditModal` refactored into `AccountModal` supporting both create and edit modes; new fields: name, type selector, parent picker (`SearchableSelect`); hidden toggle (`Eye`/`EyeOff`) in modal footer; hidden cards shown at 50% opacity; "New" button and "Show hidden" checkbox in page header
- [x] `app/src/components/LedgerFilterBar.tsx` — hidden accounts filtered out of account picker
- [x] `app/src/components/LedgerTable.tsx` — hidden accounts excluded from inline selectors
- [x] `app/src/components/QuickEntryInput.tsx` — hidden accounts excluded from `accountOptions` and `allAccountOptions`
- [x] `app/src/lib/api.ts` — `hidden` field added to `Account` interface; `createAccount`/`updateAccount` pass `hidden`

### Decisions
- Hidden accounts remain in the DB and show in `AccountsPage` (at 50% opacity) so they can be un-hidden; they are simply suppressed everywhere else in the UI.
- `AccountModal` unifies create and edit into one component to avoid duplicating the complex field layout.
- Parent picker uses `SearchableSelect` over all accounts so any account can be reparented.

### Files Created/Modified
- `migrations/0031_account_hidden.sql` (new)
- `app/src/components/AccountsPage.tsx`
- `app/src/components/LedgerFilterBar.tsx`
- `app/src/components/LedgerTable.tsx`
- `app/src/components/QuickEntryInput.tsx`
- `app/src/lib/api.ts`

---

## 2026-03-17 - Installment Feature + UI Improvements

### Tasks
- [x] **Database View: account_balances** — Refactored to include hierarchical balances (rolling up sub-accounts), `own_balance` (account-only), `last_entry_date` (most recent transaction date in the hierarchy), and `parent_id`.
- [x] **API Contract: Account & AccountNode** — Updated TypeScript interfaces to include the new fields.
- [x] **AccountsPage: "All" Tab** — Added an "All" tab to view all accounts regardless of type, including a total count.
- [x] **AccountsPage: Card Enhancements** — Updated account cards to display the hierarchical balance and the last transaction date.
- [x] **AccountsPage: Layout** — Refined card layout to be more compact and include balance/date information in an Apple-style aesthetic.
- [x] **Dashboard: Double-counting Fix** — Updated Dashboard calculations to use `own_balance` instead of hierarchical `balance` to ensure totals remain correct when parent and child accounts are filtered together.

### Decisions
- Chose to maintain both `balance` (hierarchical) and `own_balance` (non-hierarchical) to support different UI needs without extra complexity.
- Flipped signs for Income and Liability accounts in the AccountsPage UI to present "positive" values for natural states (income earned, debt owed) while using color-coding to indicate financial impact.
- Used `pt-BR` locale and `BRL` currency as the default for formatting on the account cards.

### Files Created/Modified
- `migrations/0032_account_balance_improvements.sql` (new)
- `app/src/lib/api.ts`
- `app/src/components/AccountsPage.tsx`
- `app/src/components/Dashboard.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-03-18 - Improved Income/Expense Detection and Modification

### Tasks
- [x] **QuickEntryInput: Manual Overrides** — Added a `toggleAllSigns` function to flip all entry signs in the staging area, allowing users to manually switch between income and expense classification. Added a "Toggle Sign" button to the UI.
- [x] **QuickEntryInput: Labeling Logic** — Refined the labeling and icon logic in the staging area to correctly identify 'Category' (Tag icon) and 'Account' (Wallet icon) based on their index and transaction type, regardless of the sign. This ensures refunds (negative expenses) are labeled correctly as 'Category' but with an 'income' badge.
- [x] **QuickEntryInput: Visual Feedback** — Improved the color logic in the staging area to color both category and account entries based on the detected transaction type (Red for Expense, Green for Income, Neutral for Transfer).
- [x] **LedgerTable: Correct Primary Type** — Updated the `primaryType` calculation in `allTransactionItems` and `ledgerItems` memos to correctly identify refunds (negative expenses) as income and reversals (positive income) as expenses. This ensures correct color and sign representation in the list view.
- [x] **LedgerTable: Stable Edit Type** — Refined the `editType` derivation in `TransactionRow` to check the sign of the entries, not just the account type. This ensures the color correctly updates when signs are toggled or values are modified during editing.

### Decisions
- Re-centered the "source of truth" for income/expense classification on the Asset-flow direction rather than just the presence of a specific account type.
- Used a uniform coloring scheme for entries within the editing view (entire transaction colored Red or Green) to provide high-signal feedback to the user about what kind of transaction they are creating/editing.
- Chose to maintain the 'Category' label for any entry in an expense/income account, even if the amount is negative (refund), while adding a specific 'income' badge for clarity.

### Files Modified
- `app/src/components/QuickEntryInput.tsx`
- `app/src/components/LedgerTable.tsx`
- `IMPLEMENTATION_LOG.md`

---

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

## 2026-03-08 - Transaction Editing Implementation

### Tasks
- [x] Create migration `0015_update_transaction_rpc.sql` with `update_transaction` RPC
- [x] Implement atomic transaction update (delete entries, update transaction, insert new entries)
- [x] Add balance validation and smart defaults update to `update_transaction`
- [x] Export `SearchableSelect` to a standalone component for reuse
- [x] Enhance `app/src/lib/api.ts` with `updateTransaction` function
- [x] Refactor `LedgerTable.tsx` to include `TransactionRow` with editing state
- [x] Implement interactive editing for description, date, and entries
- [x] Add support for adding and removing splits during editing
- [x] Implement auto-balancing logic in the editing UI

### Decisions
- Used an RPC for updates to ensure atomicity and reuse the complex balance/smart-defaults logic from creation.
- Extracted `SearchableSelect` to its own file to maintain DRY principles between `QuickEntryInput` and `LedgerTable`.
- Opted for a "Delete and Re-insert" strategy for entries within the RPC to simplify the handling of splits (adding/removing).
- Added an "Edit" button that only appears on hover to keep the UI clean while providing easy access to modifications.
- Implemented a "Smart Auto-balance" in the UI that adjusts the first negative entry (source account) when positive entries (categories) are modified.

### Files Created/Modified
- `migrations/0015_update_transaction_rpc.sql`
- `app/src/components/SearchableSelect.tsx`
- [x] Update `app/src/components/QuickEntryInput.tsx`
- [x] Update `app/src/components/LedgerTable.tsx`
- [x] Update `app/src/lib/api.ts`
- `IMPLEMENTATION_LOG.md`

---

## 2026-03-08 - Database Schema Fix: Added updated_at

### Tasks
- [x] Create migration `0016_add_updated_at.sql` to add `updated_at` columns
- [x] Refine `updateTransaction` in `api.ts` to exclude `created_at` from entry objects

### Decisions
- Added `updated_at` to `transactions`, `accounts`, and `entries` to fix a runtime error in the `update_transaction` RPC and support better auditing.
- Excluded `created_at` from the entries array sent to the API to minimize payload and ensure the database handles temporal data correctly.

---

## 2026-03-08 - Dashboard Chart Improvement: Dynamic Asset Growth

### Tasks
- [x] Create migration `0018_monthly_balances.sql` and `0019_daily_balances.sql`
- [x] Implement `monthly_balances` and `daily_balances` views for temporal tracking
- [x] Update `app/src/lib/api.ts` with `fetchDailyBalances`
- [x] Transition Dashboard "Cash Flow Trends" from LineChart to AreaChart
- [x] Implement dynamic granularity: Weekly for > 35 days, Daily otherwise
- [x] Set "This Year" as the default Dashboard date range
- [x] Fix chart sync issues by ensuring asset history is independent of category filters
- [x] Add re-render trigger (key) to ResponsiveContainer for stable chart updates

### Decisions
- Switched from Income/Expense lines to an Area Chart for Assets to better visualize net worth accumulation.
- Chose a 35-day threshold for granularity switching to maintain high-density readability without overcrowding the X-axis.
- Used `startOfWeek` from `date-fns` to group daily balances for the weekly view, taking the last recorded balance of each week.
- Kept `monthly_balances` view as a fallback, though the frontend currently utilizes `daily_balances` for all granularities.

### Files Created/Modified
- `migrations/0018_monthly_balances.sql`
- `migrations/0019_daily_balances.sql`
- `db/views/monthly_balances.sql`
- `db/views/daily_balances.sql`
- `app/src/lib/api.ts`
- `app/src/components/Dashboard.tsx`
- `IMPLEMENTATION_LOG.md`


### Tasks
- [x] Create migration `0017_dashboard_view.sql` with `dashboard_data` view
- [x] Install `recharts` and `date-fns` frontend dependencies
- [x] Implement `Dashboard` component with Apple-style aesthetics
- [x] Add Account Balances panel (Assets, Liabilities, Net Worth)
- [x] Implement hierarchical Expense Pie Chart (Level 1, 2, 3 support)
- [x] Implement Income Sources Pie Chart
- [x] Implement Monthly Trends Line Chart (Income vs Expenses)
- [x] Add Date Range filters with presets (This Month, Prev Month, This Year, Prev Year)
- [x] Add Custom Date Range support
- [x] Implement Category filtering via Pie Chart interaction
- [x] Integrate View Switcher in `App.tsx` (Dashboard/Ledger)

### Decisions
- Created a specialized `dashboard_data` view to provide a flat stream of entries with hierarchical account names for flexible frontend aggregation.
- Chose `recharts` for its declarative API and ease of integration with React.
- Used `date-fns` for robust date manipulation and formatting in filters.
- Implemented an "Apple-like" design using `backdrop-blur-xl`, soft gradients, and rounded corners (`rounded-[2rem]`).
- Defaulted the app view to the Dashboard for immediate financial overview.
- Handled multi-level category grouping in the frontend to allow real-time switching between summary and detail levels without extra API calls.

### Files Created/Modified
- `migrations/0017_dashboard_view.sql`
- `app/src/lib/api.ts`
- `app/src/components/Dashboard.tsx`
- `app/src/App.tsx`
- `app/package.json`
- `IMPLEMENTATION_LOG.md`


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

---

## 2026-03-08 - Optimized Excel Import Implementation

### Tasks
- [x] Create optimized Excel import script (`scripts/import_excel.py`)
- [x] Implement bulk database operations using `execute_values` for high performance
- [x] Implement surgical transaction pairing logic for transfers and credit card payments
- [x] Add visual progress bar for long-running imports
- [x] Implement automated balance validation against target values
- [x] Create database reset utility (`scripts/reset_db.py`)

### Decisions
- Used a three-tier pairing strategy: 1) Perfect description match, 2) Explicit 'Transferência' category, 3) Heuristic-based asset-to-liability matching for bill payments.
- Opted for `Decimal` throughout to ensure financial precision and avoid floating-point errors.
- Implemented chunked inserts for transactions to retrieve generated IDs efficiently without overloading the database.
- Added Unicode normalization (NFKD) to the slugification process to handle international characters in account/category names correctly.

---

## 2026-03-09 - Account Standardization & Dashboard Enhancements

### Tasks
- [x] Refine `import_excel.py` with standardized account hierarchy (`checking`, `emergency`, `investments`, `credit-card`)
- [x] Standardize category normalization in `import_excel.py` (Income vs Expenses based on keywords)
- [x] Update `QuickEntryInput.tsx` to align with new `assets:checking:` hierarchy
- [x] Enhance `Dashboard` with categorized balance cards (Checking, Emergency, Investments, Credit Cards)
- [x] Implement "Hover to Detail" in `BalanceCard` to show constituent accounts and balances
- [x] Update `daily_balances` view to support granular account subtypes using `LIKE` patterns
- [x] Transform "Asset Growth History" into "Asset Breakdown History" (Stacked Area Chart)
- [x] Fix TypeScript type errors in `Dashboard.tsx` (import types and tooltip formatters)
- [x] Verify frontend production build (`npm run build`)

### Decisions
- Adopted a strict four-tier account hierarchy for assets and liabilities to drive the dashboard's visual logic and simplify user navigation.
- Implemented the breakdown chart as a stacked area for assets (`investments` -> `emergency` -> `checking`) to visualize asset composition over time.
- Positioned `credit-card` as a separate, non-stacked dashed area to represent liabilities without distorting the positive asset stack.
- Moved account-level details into a hover popover to keep the dashboard clean while providing deep-dive capabilities for each category.
- Updated the database view `daily_balances` to pre-aggregate subtypes based on naming patterns, ensuring high performance for temporal charts while maintaining backward compatibility with base types.

### Files Created/Modified
- `scripts/import_excel.py`
- `app/src/components/Dashboard.tsx`
- `app/src/components/QuickEntryInput.tsx`
- `db/views/daily_balances.sql`
- `IMPLEMENTATION_LOG.md`

---

## 2026-03-09 - Transaction Deletion and Transformation Implementation

### Tasks
- [x] Create migration `0029_delete_transaction_rpc.sql` with `delete_transaction` RPC
- [x] Create view `account_usage` for smart account suggestions (all account types)
- [x] Implement `deleteTransaction` in `app/src/lib/api.ts` using the new RPC
- [x] Implement `fetchAccountUsage` in `app/src/lib/api.ts`
- [x] Add "Delete" button with confirmation to `LedgerTable.tsx` (Expanded & Editing views)
- [x] Enhance `TransactionRow` editing UI to support transformations (Category <-> Asset)
- [x] Integrate `topAccountOptions` into `SearchableSelect` for transfers/assets
- [x] Refine color-coded feedback during transformation (Red/Green/White)
- [x] Invalidate relevant queries (transactions, accounts) after deletion or update

### Decisions
- Chose to implement a formal `delete_transaction` RPC to maintain consistency with the project's "Postgres-first" architecture and ensure atomicity.
- Created the `account_usage` view to provide "top suggested accounts" for transfers, paralleling the `category_totals` logic but for asset/liability accounts.
- Positioned the "Delete" button in the expanded view and editing footer to ensure it's easily accessible while preventing accidental clicks through a native `window.confirm`.
- Leveraged the existing `update_transaction` RPC for "Transformations"; since the RPC deletes old entries and inserts new ones, changing an expense category to an asset account seamlessly converts an Expense into a Transfer.
- Dynamically switched `topOptions` in `SearchableSelect` based on the entry type (Categories for expenses/income, Top Accounts for transfers).

### Files Created/Modified
- `migrations/0029_delete_transaction_rpc.sql`
- `app/src/lib/api.ts`
- `app/src/components/LedgerTable.tsx`
- `IMPLEMENTATION_LOG.md`

## 2026-03-16 - Account Icons + Accounts Management Page

### Tasks
- [x] `migrations/0030_account_icon.sql` — add `icon` and `color` columns to `accounts`; rebuild `account_names_hierarchical` and `account_balances` views to expose these fields
- [x] `app/src/lib/account-icons.ts` — icon registry: institution icons (Simple Icons CDN), category icons (Lucide), keyword resolvers, `getAccountIconInfo()` helper
- [x] `app/src/components/AccountIcon.tsx` — Apple-style rounded-square badge (bank CDN logo, Lucide category icon, or initials fallback); sizes xs/sm/md/lg
- [x] `app/src/lib/api.ts` — added `icon`/`color` to `Account` interface; added `AccountNode`, `AccountAlias` types; added `fetchAccountsTree`, `updateAccount`, `createAccount`, `deleteAccount`, `fetchAliases`, `createAlias`, `deleteAlias`
- [x] `app/src/components/SearchableSelect.tsx` — extended `Option` with `icon`/`color`; renders `AccountIcon` in dropdown rows and button
- [x] `app/src/components/LedgerTable.tsx` — shows `AccountIcon` in row categories/accounts columns and in expanded entry detail; account options now carry icon/color metadata
- [x] `app/src/components/AccountsPage.tsx` — management page: type tabs (Assets/Liabilities/Expenses/Income/Equity), account list with icons, edit drawer (icon picker, color picker, alias manager, delete)
- [x] `app/src/App.tsx` — added "Accounts" nav tab (BookMarked icon) routing to `AccountsPage`
- [x] `scripts/import_excel.py` — `INSTITUTION_ICON_MAP` + `CATEGORY_ICON_MAP` constants; `auto_assign_icon()` called from `get_or_create_account()` to set icon/color on newly-created accounts (only when icon IS NULL)

### Design Decisions
- Bank institution logos served from Simple Icons CDN (`https://cdn.simpleicons.org/{slug}/ffffff`) — white logo on brand-colored background; no downloaded SVG assets needed
- Brands not in Simple Icons (xp, rico, brb, infinitepay, nomad) use initials badge with brand color
- Keyword matching on leaf account slug for assets/liabilities; first-level category slug for expenses/income
- `account_balances` view updated to propagate `icon`/`color` so `fetchAccounts()` returns these fields for immediate use in LedgerTable without an extra query

### Files Created/Modified
- `migrations/0030_account_icon.sql` (new)
- `app/src/lib/account-icons.ts` (new)
- `app/src/components/AccountIcon.tsx` (new)
- `app/src/components/AccountsPage.tsx` (new)
- `app/src/lib/api.ts`
- `app/src/components/SearchableSelect.tsx`
- `app/src/components/LedgerTable.tsx`
- `app/src/App.tsx`
- `scripts/import_excel.py`

## 2026-03-16 (follow-up) - Icon fixes, AccountsPage cards, alias import

### Issues fixed
- **Icons not resolving for bare leaf names**: `getAccountIconInfo` now handles single-segment names (e.g. `nubank` from `entry.account_name`) by trying institution keyword matching and category slug matching without requiring a full hierarchical path
- **LedgerTable row icon lookup**: Changed row columns to look up account icons via `account_id` from `item.entries` instead of matching by `account_name` string (which was comparing leaf names against full-path keys)
- **QuickEntryInput/FilterBar missing icon metadata**: `accountOptions`, `allAccountOptions`, `topCategoryOptions` now include `icon`/`color` fields — icons appear in account selector and preview entry rows
- **MultiSearchableSelect**: Added `icon`/`color` to `Option` type; renders `AccountIcon` in dropdown rows and single-selection button display
- **LedgerFilterBar**: Account options now pass `icon`/`color` to MultiSearchableSelect

### AccountsPage redesign
- Replaced list layout with responsive Apple-style card grid (2–4 columns)
- Each card shows: `AccountIcon` (md), leaf name, parent path (muted mono), alias pills
- Click anywhere on card opens edit modal (no separate edit button)
- Modal header: large icon preview that updates live as icon/color picker changes
- Cleaner modal with white Save button, destructive Delete in footer left

### import_excel.py aliases
- Added `add_alias_if_missing(cur, account_id, alias)` — inserts lowercase alias into `account_aliases`, ignoring conflicts
- `get_or_create_account` now accepts optional `original_name` for direct alias registration
- During `import_excel`, builds `alias_map: dict[normalized_path → set[original_name]]` from all rows (both `Conta` and `Categoria` columns)
- After account creation loop, calls `add_alias_if_missing` for each original Excel name — e.g. `"Nubank"` → alias on `assets:checking:nubank`; `"Alimentação"` and full `"Despesas - Alimentação"` → aliases on `expenses:alimentacao`

### Files modified
- `app/src/lib/account-icons.ts`
- `app/src/components/LedgerTable.tsx`
- `app/src/components/QuickEntryInput.tsx`
- `app/src/components/LedgerFilterBar.tsx`
- `app/src/components/MultiSearchableSelect.tsx`
- `app/src/components/AccountsPage.tsx`
- `scripts/import_excel.py`
