# ADVISOR.md — AI Finances Advisor

Implementation specification for the AI-assisted advisor, bookkeeper and assistant that sits on top of
the ledger. This document is written for an AI coding agent to implement end to end. Read `PRODUCT.md`,
`DOMAINS.md`, `LEDGER_RULES.md`, `ARCHITECTURE.md` and `API_CONTRACT.md` first; the advisor never
bypasses the ledger model those documents define.

Decisions recorded here were taken with the maintainer on 2026-10-14 after a full investigation of the
repo, the maintainer's deployment, mailbox and sibling projects. Where this document says "decided", do
not reopen the choice; where it says "open", record the outcome in `LEDGER.md`.

**This is an open-source app.** Everything shipped under this spec must be runnable by anyone with the
repo: no hard-coded domains, ids, mailboxes or hosts in code or docs. Operator-specific values are
environment variables; the maintainer's own instance is described only as an example in Appendix A.

---

# 0. Start here (implementing agent)

**Status: implemented on 2026-10-14 (phases 0–3, branch `advisor`).** The daemon lives in `advisor/`,
the migrations are 0047–0051, the web slice is under `app/src/components/advisor/`. This document stays
the design contract; `advisor/README.md` is the operator manual and `IMPLEMENTATION_LOG.md` records the
acceptance checks. Open follow-ups are in `LEDGER.md` (classifier threshold tuning, Gmail OAuth client,
split action, shared login). Do not reopen decisions marked "decided"; append questions to `LEDGER.md`
and keep building under the stated assumption.

**Order of work.** Phases 0 → 3 in §17, each phase a reviewable unit. Inside a phase: migrations and
SQL tests first, then the daemon module with its vitest suite, then the frontend slice, then the
acceptance check. Ship the smallest end-to-end slice early (Phase 1's "upload an OFX, approve, balance
matches") rather than finishing every module in isolation.

**Repository conventions that apply.** `RULES.md` (TDD for parsers, matcher, classifier, gate, plan
schema, reconciliation math; conventional commits; frontend stack), `AI_GUIDELINES.md`, an
`IMPLEMENTATION_LOG.md` entry per session, `LEDGER.md` for open items, `MIGRATION_STRATEGY.md` for SQL.
Never edit an existing migration. Never add owner-specific values to the repo (see above). Add the
`advisor/` commands to `CLAUDE.md` once the package exists.

**Fixed implementation choices** (so no time is spent choosing):

| Concern | Choice |
|---|---|
| Daemon runtime | Node 22, TypeScript ~5.9, ESM, npm (same as `app/` and `mcp-server/`) |
| HTTP server | Hono (`@hono/node-server`), SSE via `streamSSE` |
| Postgres | `pg` (node-postgres) with a small typed repo layer, no ORM |
| Validation | zod 4 (shared shapes with `mcp-server/`) |
| MCP server | `@modelcontextprotocol/server` Streamable HTTP transport on `127.0.0.1:MCP_PORT` |
| Discord | discord.js v14 |
| Gmail | Google REST via `fetch`, refresh-token flow, no SDK |
| OFX parsing | own parser (SGML + XML), fixtures from real anonymised Nubank files |
| PDF text | `pdftotext -layout` (poppler) via child process |
| Logging | pino, JSON to stdout |
| Tests | vitest everywhere; SQL tested from vitest against a throwaway Postgres (`docker compose` `db` service, or `TEST_DATABASE_URL`), migrations applied by `scripts/migrate.py` |
| Image | `ghcr.io/<repo-owner>/finances-advisor`, built by `.github/workflows/advisor-image.yml` |
| Frontend | React 19, TanStack Query, shadcn/ui, Tailwind v4, existing `SearchableSelect`/`AccountIcon`/`BudgetBar` components |

**Local development loop.** `docker compose up db postgrest` (or the full stack) for a database;
`python scripts/migrate.py` with `DATABASE_URL` pointing at it; `cd advisor && npm run dev` (tsx watch)
with `ADVISOR_CHANNELS=web`; `cd app && npm run dev` with `VITE_APP_ADVISOR_URL=http://localhost:3100`.
A real Claude login is needed for session tests (`claude login` once on the dev machine; the runner
honours `CLAUDE_BIN`). Unit tests never call Claude: the runner is tested with a fake `claude` script
that replays recorded `stream-json`.

**Safety rails while building.** Work only against a dev database. The applier refuses to run when
`ADVISOR_ENV=prod` and `DATABASE_URL` lacks the configured `PROD_DATABASE_NAME`, and vice versa, so a
mis-pointed env fails loudly. No test writes to `transactions` without a surrounding transaction that
rolls back, except the end-to-end acceptance checks on the dev database.

**Definition of done per phase.** Tests green (`npm test` in `advisor/` and `app/`, SQL suite), lint
clean, acceptance check in §17 performed against dev and recorded in `IMPLEMENTATION_LOG.md` with the
exact command or steps, docs (`API_CONTRACT.md` for new RPCs/views, `compose.yaml` banner for new env
vars, `advisor/README.md`) updated in the same PR, conventional commits on a feature branch, PR to
`main`.

---

# 1. Goal and scope

The advisor turns the ledger from a fast manual-entry tool into a system that:

1. **Ingests** bank statements and receipts (Gmail, uploads) and turns them into balanced ledger
   transactions through an **insertion plan** the user reviews, edits and approves.
2. **Reconciles** ledger balances against statement or stated balances, keeps a history of every
   reconciliation, investigates gaps, and books adjustments only on the user's say-so.
3. **Advises**: budget planning and review, spending analysis, "can I afford X", all grounded in live
   queries, navigated by natural language.
4. **Nudges** on Discord when something arrives or an account goes stale.

In scope: one household ledger (one database). Out of scope: any account with `hidden = true` (the
maintainer keeps a company's accounts hidden in the same ledger). The advisor must never propose
entries on hidden accounts.

Decided constraints:

| Decision | Value |
|---|---|
| Runtime | One Docker container (`advisor` service), deployable next to Postgres and PostgREST with the repo's `compose.yaml` or any orchestrator |
| Claude access | **Claude Code CLI** logged into the operator's Claude subscription (OAuth). No API-key fallback in v1. |
| Write control | **Plan-then-apply.** Claude only reads and drafts plans. Code applies approved plans. |
| Agent model | **Agentic, resumable Claude Code sessions** with read-only ledger tools, plan-drafting tools, and a sandboxed workspace. |
| Primary surface | **Web app** (new Advisor view in `app/`): chat, conversations, plan review/editor. Discord for notifications, approvals and casual check-ins. |
| Ingestion v1 | Gmail watch (Nubank OFX/CSV/PDF), files dropped in web or Discord, casual balance check-ins. **No Open Finance / Pluggy.** |
| Household | Both household members. Any valid finances token can chat; either can approve any plan. |
| Reconciliation | First-class resource per account and statement period (cleared / outstanding / missing / difference, continuity between periods). **Investigate first**, adjust only when told, adjustments to a suspense account. |
| Classification | **Derived, multi-factor** (`classify_candidates`: name, raw statement text, amount, account, weekday/day-of-month/hour, recency) replacing stored description memories; the only learned fact is raw text → household name. |
| Gate | Usage gate applies to routine work only. Interactive messages are never gated or queued behind background work. |
| Proactivity | Only when something arrives or an account becomes due for a check (cadence by usage, migration 0057). No fixed digest. |
| Code location | `advisor/` package in this repo. Image published by this repo's CI (`ghcr.io/<owner>/finances-advisor`, overridable). |
| Language | Mirror the user's language. Ledger data stays as entered. |
| Models | Opus for sessions (chat, reconciliation, budgeting). Sonnet for routine calls (Gmail routing, statement verification, nudges). Both configurable. |
| Discord | Any guild and bot the operator owns; guild, channel and obeyed user ids come from env. |
| Legacy | Budget module becomes agent-first; unused ornaments (piggy-bank indicator) go. See §19. |

---

# 2. Investigation findings the design relies on

- The maintainer's ledger: ~9.7k transactions since 2022, 132 accounts, ~5.9k description memories.
  `transactions.metadata` is `{}` on every row: there is **no provenance and no dedup key** today.
  Migrations are at `0046`.
- Entry happens in bursts (700+ transactions in one month after a quiet one). `last_checked` goes stale
  for weeks. "Ajuste" is the third most used description (booked to `sem-categoria`). Reconciliation
  adjustments are a real practice with no record of why.
- Nubank (the most common Brazilian bank among users of this app) emails account statements **on
  request** as OFX + PDF + CSV (`Extrato da sua conta do Nubank`, attachments
  `NU_<acctid>_<DDMMMYYYY>_<DDMMMYYYY>.{ofx,pdf,csv}`) and the card bill as CSV (`Extrato da fatura do
  Cartão Nubank`, `Nubank_<YYYY-MM-DD>.csv`). Most other institutions do not email statements; they are
  manual exports or screenshots.
- A sibling project of the maintainer (territorial-assistant) runs Claude Code headless as single-shot
  `claude -p` calls with JSON schemas, gates background work on **subscription usage** (reads the OAuth
  token, polls `https://api.anthropic.com/api/oauth/usage`, runs only when the 5-hour and 7-day windows
  are quiet), and applies "Claude proposes a closed action set, code applies after ✅". It runs on a Mac
  because the token lives in the macOS keychain; nothing there has run `claude` in Docker. Port the
  patterns; do not depend on that code.
- Claude Code `2.1.300` headless flags available: `-p`, `--output-format
  stream-json`, `--resume`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools`, `--disallowedTools`,
  `--append-system-prompt`, `--setting-sources`, `--add-dir`, `--model`, `--effort`, `--json-schema`,
  `--permission-mode`, `--permission-prompts`. On Linux the login is stored in
  `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`, `refreshToken`, `expiresAt`), not a keychain.

---

# 3. Architecture

```
                  ┌──────────────────────── docker host ──────────────────────────┐
Gmail (operator) ─┤  advisor (Node 22 daemon)                                      │
Discord gateway ──┤   ├─ http      :3100  web chat (SSE), plans, uploads, health   │
Web app ──────────┤   ├─ discord   gateway bot, threads, ✅ approvals              │
                  │   ├─ gmail     history walker → advisor_statements             │
                  │   ├─ scheduler cheap tick 15m · claude tick 5m · usage gate    │
                  │   ├─ runner    spawns `claude -p` sessions (OAuth volume)      │
                  │   ├─ mcp       Streamable-HTTP MCP server on 127.0.0.1:3101    │
                  │   │             read tools + plan tools, per-session bearer    │
                  │   └─ applier   approved plan → PostgREST RPCs → ledger         │
                  │        │                 │                                      │
                  │   advisor_* tables   postgrest:3000  ──────► Postgres          │
                  └────────────────────────────────────────────────────────────────┘
```

Principles:

- **Postgres stays the source of truth.** All ledger writes go through the existing RPCs
  (`create_transaction`, `update_transaction`, `delete_transaction`, budget RPCs) via PostgREST with a
  dedicated advisor auth token, so invariants, description memories and `global_settings` behave exactly
  as for the web app.
- **Claude never holds a write tool to the ledger.** It reads, reasons, and drafts plans into
  `advisor_plans`/`advisor_plan_items` (draft state only). The daemon applies plans after approval.
- **Claude's process environment holds no secrets.** The MCP server runs inside the daemon and is reached
  over localhost with a per-session bearer token; `DATABASE_URL`, Discord and Gmail secrets never enter the
  `claude` child process.
- **Every inbound event is idempotent** (`advisor_events` keyed by source + external id) and every Claude
  call is logged (`advisor_claude_calls`). Jobs hold nothing across ticks.

---

# 4. Repository layout

```
advisor/
  package.json            npm, "type": "module", Node 22, TypeScript ~5.9, vitest
  tsconfig.json
  Dockerfile
  README.md               run, login, re-auth runbook
  prompts/
    advisor.system.md     session system prompt (see §9)
    route-mail.system.md  + route-mail.schema.json   (Sonnet, single-shot)
    verify-statement.system.md + .schema.json         (Sonnet, single-shot)
    nudge.system.md       + nudge.schema.json          (Sonnet, single-shot)
  src/
    main.ts               boots http, discord, gmail, scheduler; graceful shutdown
    config.ts             zod-validated env
    log.ts                scoped logger (pino), owner-action context
    db/
      client.ts           pg Pool on DATABASE_URL
      repo/*.ts           one module per advisor_* table
    postgrest/
      client.ts           login_with_token → JWT cache → callRpc/getView (port of mcp-server/src/{auth,postgrest-client}.ts)
    claude/
      credentials.ts      read ~/.claude/.credentials.json, expiry, health
      usage.ts            GET /api/oauth/usage, snapshot to advisor_usage_snapshots
      gate.ts             evaluateGate / evaluateInteractiveGate (pure, tested)
      runner.ts           spawn claude -p (session + single-shot modes), stream-json parser, call log
      session.ts          conversation ↔ claude session id, workspace dir lifecycle
    mcp/
      server.ts           McpServer over Streamable HTTP, bearer per session
      tools/ledger-read.ts   list_account_balances, list_transactions, match_account, match_description_memory, get_category_totals, get_dashboard_data, list_daily_account_balances, get_monthly_balances, list_accounts_hierarchical, list_description_memories, list_budget_items, list_budget_monthly_spending, get_category_monthly_history
      tools/advisor.ts       statement_get, statement_lines, reconciliation_history, note_list, note_add, plan_create, plan_set_items, plan_finalize, plan_get, conversation_summary_set
    ingest/
      detect.ts           institution + format detection from sender/filename/content
      ofx.ts              OFX parser (SGML and XML), FITID, LEDGERBAL
      nubank-csv.ts       account CSV (Data,Valor,Identificador,Descrição) and card CSV (date,title,amount)
      pdf.ts              pdftotext -layout wrapper; readers for Nubank, Itaú and BRB PDFs
      normalize.ts        StatementLine model, hashing, period/balance extraction
      match.ts            dedup against ledger (fitid, fuzzy), transfer pairing
    plan/
      schema.ts           zod: PlanItem kinds, entries, validation (balance, no hidden accounts, reopens_reconciliation flag)
      apply.ts            approved plan → RPC calls, per-item status, provenance metadata (statement_line)
      reconcile.ts        open/set-items/close reconciliation around an apply; continuity check; difference report
    http/
      server.ts           Hono (or Fastify) on :3100, JWT auth, CORS
      routes/chat.ts      POST /conversations, POST /conversations/:id/messages (SSE), GET list/detail
      routes/plans.ts     GET /plans, GET /plans/:id, PATCH /plans/:id/items/:itemId, POST /plans/:id/approve|reject|replan
      routes/uploads.ts   POST /uploads (multipart) → advisor_statements → conversation message
      routes/health.ts    GET /health (db, claude credentials, discord, gmail cursor)
    discord/
      bot.ts              discord.js v14 gateway, obeyed users, threads, ✅/👍 reactions, attachments
      poster.ts           chunking at 2000 chars, files, thread creation
    gmail/
      client.ts           OAuth refresh-token client (REST), history walker, attachments.get
      sync.ts             cursor in advisor_state, rules → advisor_statements
    jobs/
      ingest-statement.ts received → parsed → session → plan → notify
      stale-accounts.ts   30+ days since last_checked → Discord
      pending-plans.ts    remind about plans awaiting approval (daily, once)
      claude-health.ts    credentials expiry + haiku ping, alert on failure
  test/                   vitest: parsers, match, plan schema, gate, apply (against a throwaway DB or mocked RPC)
app/src/components/advisor/   AdvisorPage, ConversationList, ChatPanel, PlanReview, PlanItemRow, UploadDrop
app/src/lib/advisor-api.ts    typed client for the advisor HTTP API
migrations/0047_transaction_provenance.sql
migrations/0048_advisor_tables.sql
migrations/0049_ajustes_account.sql
migrations/0050_derived_classification.sql
migrations/0051_reconciliations.sql
.github/workflows/advisor-image.yml
```

Reuse from `mcp-server/src/`: port `auth.ts` and `postgrest-client.ts` to Node (replace `fetch` caching
semantics with a process-lifetime cache). Do not import the Workers package directly.

---

# 5. Database changes

All in new migrations (never edit existing ones), idempotent, `NOTIFY pgrst, 'reload schema'` at the end.

## 5.1 `0047_transaction_provenance.sql`

- Replace `create_transaction` and `update_transaction` with versions that accept an extra
  `p_metadata JSONB DEFAULT '{}'::jsonb` (DROP FUNCTION of the exact current signature, then CREATE with
  the body unchanged except `metadata = p_metadata` on insert/update). Callers passing three arguments
  keep working. Re-grant `EXECUTE` to `authenticated`.
- `CREATE INDEX IF NOT EXISTS idx_transactions_metadata_fitid ON transactions ((metadata->>'fitid'))
  WHERE metadata ? 'fitid';`
- `CREATE INDEX IF NOT EXISTS idx_transactions_metadata_source ON transactions ((metadata->>'source'));`

Provenance written by the applier on every transaction it creates or updates:

```json
{
  "source": "advisor",
  "plan_id": "uuid", "plan_item_id": "uuid",
  "statement_id": "uuid", "institution": "nubank", "fitid": "66f1...",
  "statement_line_hash": "sha256", "approved_by": "token-description-or-discord-id"
}
```

## 5.2 `0048_advisor_tables.sql`

All tables in `public`, prefixed `advisor_`, granted to `authenticated`. Timestamps `timestamptz default now()`.

```
advisor_state            key text pk, value jsonb, updated_at          -- cursors (gmail history id, last nudge)
advisor_events           id uuid pk, source text (discord|gmail|web|scheduler), external_id text,
                         kind text, payload jsonb, outcome text, created_at
                         unique (source, external_id)
advisor_conversations    id uuid pk, channel text (web|discord|system), external_ref text,   -- discord thread id
                         title text, claude_session_id text, model text, created_by text,
                         summary text, status text (active|archived), created_at, last_activity_at
advisor_messages         id uuid pk, conversation_id fk, role text (user|assistant|system|tool),
                         content text, attachments jsonb, created_at
advisor_statements       id uuid pk, account_id uuid null fk accounts, source text (gmail|upload),
                         institution text, kind text (account|card|investment|other),
                         format text (ofx|csv|pdf|image|xlsx), filename text, sha256 text unique,
                         storage_path text, gmail_message_id text, period_start date, period_end date,
                         currency text, opening_balance numeric, closing_balance numeric,
                         lines jsonb,                 -- normalized StatementLine[] (see §7)
                         status text (received|parsed|planned|applied|ignored|failed), error text,
                         conversation_id uuid null, created_at
advisor_plans            id uuid pk, conversation_id fk, statement_id uuid null fk,
                         title text, summary text, status text
                         (draft|pending_approval|approved|applying|applied|rejected|failed),
                         version int default 1, created_by text, approved_by text, approved_at,
                         applied_at, result jsonb, created_at, updated_at
advisor_plan_items       id uuid pk, plan_id fk, seq int, kind text
                         (create|update|delete|adjust|budget_upsert|budget_delete|mark_checked|skip|
                          account_create|account_update),   -- the last two since migration 0052
                         transaction_id uuid null, date date, description text,
                         entries jsonb,               -- [{account_id, amount, currency, exchange_rate, amount_base}]
                                                      -- account_id may be "new:<ref>" → an account_create item earlier in the plan
                         payload jsonb,               -- kind-specific (budget fields, account for mark_checked,
                                                      -- {ref,name,type,subtype,parent_id} for account_create)
                         source_ref jsonb,            -- {statement_id, line_hash, fitid}
                         confidence numeric, rationale text,
                         status text (proposed|edited|removed|applied|failed), applied_transaction_id uuid,
                         error text, updated_at
                         unique (plan_id, seq)
advisor_notes            id uuid pk, scope text (global|account|category), ref_id uuid null,
                         note text, created_by text, created_at
advisor_claude_calls     id uuid pk, conversation_id uuid null, claude_session_id text, mode text
                         (session|single), model text, started_at, duration_ms int, exit_code int,
                         usage jsonb, cost_usd numeric, error text
advisor_usage_snapshots  id bigserial pk, at timestamptz, five_hour_pct numeric, five_hour_resets_at,
                         seven_day_pct numeric, seven_day_resets_at, locked bool, decision text, reason text
```

Views for the web app (optional but cheap): `advisor_plans_with_counts` (items per status).

## 5.3 `0049_ajustes_account.sql`

Seed a root account `ajustes` of type `expense`, subtype `category`, icon `scale`, if it does not exist.
It is the ledger's **suspense account**: positive balance = unexplained outflow, negative = unexplained
inflow. The advisor books every reconciliation adjustment here, never to `sem-categoria`, so the
historical "Ajuste" noise stops growing, and it reviews the suspense balance when asked (§8).

## 5.4 `0050_derived_classification.sql` (see §21)

- `merchant_aliases(raw_normalized text primary key, canonical_description text not null, account_id uuid
  null references accounts, source text check (source in ('plan','manual','import')), hits int default 1,
  created_at, updated_at)`. Maps the **raw statement text** (`TAMPOPO ALIMENTOS LTDA`) to the short name
  the household uses (`Tampopo`). Learned, never guessed.
- `normalize_merchant(text) returns text`: `normalize_text()` plus removal of legal suffixes (`LTDA`,
  `ME`, `EPP`, `S/A`, `SA`), processor prefixes (`PG *`, `PAG*`, `MP *`, `PIX`, `TRANSFERÊNCIA
  ENVIADA PELO PIX -`, `COMPRA NO DÉBITO`), trailing digits, installment markers (`3/6`, `(3 de 6)`),
  cities and UF codes when they trail the name. Immutable, tested with fixtures.
- `transaction_lines` view: one row per category entry (expense/income account) joined with its
  transaction, its asset/liability counterpart, `normalize_text(description)` as `norm_description`,
  `normalize_merchant(metadata #>> '{statement_line,raw}')` as `norm_raw`, `metadata #>>
  '{statement_line,posted_at}'` as `posted_at`. The classifier's only input.
- `classify_candidates(p_description text, p_amount numeric default null, p_account_id uuid default null,
  p_date date default null, p_posted_at timestamptz default null, p_raw text default null, p_limit int
  default 5)` returning `(category_id, category_name, canonical_description, score, confidence,
  n_matches, factors jsonb)`. Definition in §21.
- Redefine `match_description_memory(p_input)` as a thin wrapper over `classify_candidates` with the
  **same return shape** the web app expects, so `QuickEntryInput` keeps working unchanged.
- Redefine the `description_memories_with_names` view as a derived aggregate over `transaction_lines`
  (description, dominant category, dominant account, last currency, usage_count, last_used_at) so the
  app's autocomplete reads live data. The `description_memories` table stays (never dropped) but
  `create_transaction`/`update_transaction` stop writing to it; the new versions instead upsert
  `merchant_aliases` whenever `p_metadata #>> '{statement_line,raw}'` is present.
- `global_settings` key `classifier_weights` (JSON) with the defaults from §21, editable without a
  migration.

## 5.5 `0051_reconciliations.sql` (see §8)

Reconciliation is a **core ledger resource**, not an advisor table, so the web app and the MCP Worker can
read it too.

```
reconciliations        id uuid pk, account_id fk accounts, period_start date, period_end date,
                       currency text, statement_opening numeric null, statement_closing numeric not null,
                       ledger_opening numeric, ledger_closing numeric, cleared_total numeric,
                       outstanding_total numeric, difference numeric,
                       status text (open|balanced|adjusted|abandoned),
                       adjustment_transaction_id uuid null, statement_ref text null,    -- advisor_statements.id as text
                       notes text, created_by text, created_at, closed_at
                       check (period_end >= period_start)
reconciliation_items   id uuid pk, reconciliation_id fk (cascade), kind text
                       (cleared|outstanding|missing|duplicate|adjustment), entry_id uuid null fk entries,
                       statement_line_hash text null, amount numeric, note text
                       unique (reconciliation_id, entry_id) where entry_id is not null
```

Views and RPCs:

- `entry_clearings` view: `entry_id, reconciliation_id, period_end` for every `cleared` item (an entry is
  *cleared* when a statement line vouched for it).
- `account_reconciliation_status` view: per account `reconciled_through` (max `period_end` with status
  `balanced|adjusted`), `last_status`, `open_difference`, `suspense_balance` (balance of `ajustes`
  entries whose transactions reference this account).
- `account_balances` gains `reconciled_through` and `cleared_balance` (sum of cleared entries up to
  `CURRENT_DATE`) via `CREATE OR REPLACE` with the columns appended.
- `open_reconciliation(p_account_id, p_period_start, p_period_end, p_statement_opening,
  p_statement_closing, p_currency, p_statement_ref)`: computes `ledger_opening` (balance as of
  `period_start - 1`) and `ledger_closing`, checks **continuity** (`statement_opening` must equal the
  previous balanced reconciliation's `statement_closing` when both exist; a mismatch is stored in
  `notes` and returned, never silently accepted), inserts the row as `open`, returns it.
- `set_reconciliation_items(p_id, p_items jsonb)`: replaces items, recomputes `cleared_total`,
  `outstanding_total`, `difference = statement_closing − (ledger_opening + cleared_total)`.
- `close_reconciliation(p_id, p_status, p_adjustment_transaction_id, p_notes)`: allows `balanced` only
  when `|difference| < 0.005`, `adjusted` only with an adjustment transaction whose `ajustes` leg equals
  the difference, sets `closed_at`, and updates `accounts.last_checked`.
- All granted to `authenticated`; all idempotent.

Open (record in `LEDGER.md`): `daily_balances` defines `net_worth` as asset + liability + equity, so an
equity-type adjustments account would cancel itself out in the chart. Expense type is correct for net
worth today; revisit if the net-worth definition changes.

---

# 6. Claude integration

## 6.1 Credentials and gate

- The container runs as user `advisor` with `HOME=/home/advisor`; `/home/advisor/.claude` is a named
  volume holding `.credentials.json`, `settings.json` and session transcripts.
- First login: `docker exec -it finances-advisor claude login` prints a URL; the owner completes it on any
  device. `claude/credentials.ts` reads `claudeAiOauth.{accessToken,expiresAt}`; the CLI refreshes the
  token itself during calls. `jobs/claude-health.ts` runs daily: if `expiresAt` is within 48 h and a
  `claude -p "pong" --model haiku` ping fails, post the re-auth runbook to Discord.
- `claude/gate.ts` is a port of territorial-assistant's `evaluateGate` with the same defaults:
  `GATE_MAX_7D_PCT=85`, `GATE_MAX_5H_PCT=70`, `GATE_MAX_CALLS_PER_WINDOW=40`, `GATE_TAIL_MINUTES=60`,
  `GATE_IDLE_MINUTES=15`. **The gate applies to routine work only** (Gmail-triggered plans, nudges,
  digests, health pings, classification audits). **Interactive work never consults the gate**: a user
  message in web or Discord starts its Claude turn immediately, with no usage check and no queueing
  behind background work. If Anthropic itself refuses the call (usage window exhausted), the error is
  shown to the user with the reset time; the daemon never pre-empts that decision. Every gate check for
  routine work writes `advisor_usage_snapshots`.
- Concurrency reserves capacity for people: `MAX_CONCURRENT_SESSIONS` (default 2) applies to interactive
  sessions; background work gets at most **one** slot and yields (finishes its current turn, then
  pauses) whenever an interactive session is waiting for a slot.

## 6.2 Session mode (Opus)

One Claude Code session per conversation. The runner spawns:

```
claude -p <message>
  --output-format stream-json --verbose
  --model opus --effort high
  --append-system-prompt-file advisor/prompts/advisor.system.md
  --setting-sources ""                       # ignore host settings/CLAUDE.md
  --strict-mcp-config --mcp-config <workspace>/mcp.json
  --allowedTools "mcp__advisor__*" "Read" "Glob" "Grep" "Bash(python3 *)" "Bash(pdftotext *)" "Bash(ls *)" "Bash(head *)" "Bash(wc *)"
  --disallowedTools "Write" "Edit" "MultiEdit" "NotebookEdit" "WebFetch" "WebSearch" "Task" "Agent"
  --permission-mode default --permission-prompts none
  --add-dir <workspace>
  [--resume <claude_session_id>]
```

- `cwd` is the conversation **workspace** `/data/workspaces/<conversation_id>/` containing
  `statements/<id>.{ofx,csv,pdf,png}` and `statements/<id>.lines.csv` (normalized lines), a `README.txt`
  listing what is there, and nothing else. Python is for arithmetic and CSV crunching only.
- The first run captures `session_id` from the `system`/`init` event in the stream and stores it on
  `advisor_conversations.claude_session_id`; later turns pass `--resume`.
- The stream is parsed incrementally: `assistant` text deltas go to the SSE channel (web) or are
  buffered for Discord; tool calls are summarised as progress lines ("reading statement…", "checking
  balance as of 2026-09-30…"); the final `result` event gives usage and cost → `advisor_claude_calls`.
- `mcp.json` points at `http://127.0.0.1:3101/mcp` with header `Authorization: Bearer <session token>`.
  The token is minted per run and maps to the conversation; the MCP server scopes plan tools to it.
- Env for the child: `HOME`, `PATH`, `TZ=America/Sao_Paulo`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
  nothing else. Strip all `CLAUDE_*` and app secrets.
- Timeouts: 15 minutes per turn; on timeout kill the process tree, mark the message failed, tell the user.
- Concurrency: see §6.1 (interactive first, background yields).

## 6.3 Single-shot mode (Sonnet)

For `route-mail`, `verify-statement`, `nudge`: `claude -p --output-format json --json-schema <schema>
--model sonnet --tools "" --allowedTools StructuredOutput --strict-mcp-config --mcp-config
'{"mcpServers":{}}' --setting-sources "" --system-prompt <file> --no-session-persistence`, input as JSON
on stdin, output validated with zod, one retry with the validation error appended.

## 6.4 MCP tools exposed to sessions

Read tools mirror `mcp-server/` names and shapes (so `ADVISOR_PROMPT.md` knowledge carries over) but are
served locally against PostgREST with the advisor token. Add:

| Tool | Purpose |
|---|---|
| `get_category_monthly_history(account_id, months)` | existing RPC, missing from the Worker |
| `classify_candidates(description, amount?, account_id?, date?, posted_at?, raw?)` | ranked categories with per-factor evidence (§21); the agent's primary categorisation tool |
| `merchant_alias_get(raw)` / `merchant_alias_set(raw, canonical_description, account_id?)` | read or teach raw-statement-text → household name mappings (writes only the alias table, never the ledger) |
| `statement_get(id)` / `statement_lines(id, offset, limit)` | metadata and normalized lines, with `already_in_ledger`, `alias` and `candidates` pre-filled by `ingest/match.ts` |
| `statement_list(institution?, kind?, limit)` | every statement, any conversation, newest first, with a `waiting` flag (parsed, no plan, nobody spoke in its conversation) |
| `mailbox_check()` | reads the watched mailbox now (interactive: unknown senders are routed without the gate) and returns the mails handled |
| `statement_claim(ids)` | moves waiting mailed statements into the current conversation (files copied into its workspace; the emptied conversation is archived) so they are planned here, in the same turn |
| `batch_prepare(statement_ids, account_id?)` | one plan for every statement of an account that arrived together: vouches lines that already match (same amount, one free candidate within 3 days), drafts cent corrections as automatic `update` items, returns per period the unmatched lines with candidates and the ledger entries no line vouches for |
| `plan_add_items(plan_id, items)` | appends items (keeps the automatic ones); `plan_set_items` still replaces |
| `plan_projected_balance(plan_id, account_id?)` | today's ledger balance plus the plan's effect on the account, to compare with the figure the person reads in the bank app |
| `statement_set_meta(id, period_start?, period_end?, opening_balance?, closing_balance?, account_id?)` | fills what the parser could not read; when the statement's plan is already applied, opens its reconciliation now |
| `ledger_balance_as_of(account_id, date)` | `SUM(amount_base)` up to a date (uses `daily_account_balances`) |
| `reconciliation_history(account_id, limit)` / `reconciliation_get(id)` | past reconciliations with items, newest first; `reconciled_through` per account |
| `uncleared_entries(account_id, through_date)` | ledger entries on the account not vouched by any statement, for outstanding-item analysis |
| `note_list(scope, ref_id)` / `note_add(scope, ref_id, note)` | the advisor's own memory of facts about accounts and categories |
| `plan_create(title, statement_id?)` | creates a `draft` plan bound to this conversation; returns id |
| `plan_set_items(plan_id, items[])` | replaces all items (validated: balance to zero, no hidden accounts, dates, known account ids) |
| `plan_finalize(plan_id, summary)` | `draft → pending_approval`; triggers notification |
| `plan_get(plan_id)` | current items and statuses (after user edits) |
| `conversation_summary_set(text)` | rolling summary stored on the conversation |

No tool creates, updates or deletes ledger transactions, accounts or budgets.

---

# 7. Ingestion pipeline

```
Gmail / upload  →  advisor_statements(received)
  → detect institution + format
  → parse (ofx | nubank-csv | pdf→text | image passthrough)   → lines, period, balances  → status parsed
  → match against ledger (fitid exact → likely duplicate by date±2d + amount + similarity → new)
  → open/resume conversation, workspace with files + lines.csv
  → session message: "Statement <id> received. Build the insertion plan."
  → Claude: reads lines, resolves categories (memory → match_account → judgement), pairs transfers,
     drafts plan via plan_create/plan_set_items, runs balance check, plan_finalize
  → notify (web badge + Discord thread with summary, counts, closing balance delta)
  → user edits/approves → applier → reconciliation row → statement applied
```

`StatementLine` (normalized, stored in `advisor_statements.lines` and exported as CSV):

```
{ hash, date, posted_at?, amount, currency, raw, description_hint, fitid?, kind (debit|credit),
  balance_after?, counterparty?, alias?: { canonical_description, account_id },
  candidates?: [{ category_name, score, confidence }] }
```

`raw` is the statement text exactly as the bank wrote it; `description_hint` is
`normalize_merchant(raw)` in Title Case; `alias` is filled from `merchant_aliases` when the raw text is
known; `candidates` are the top 3 from `classify_candidates` for that line. Every transaction the applier
creates carries `metadata.statement_line = { raw, posted_at, fitid, hash }`, which is what makes the
classifier (§21) learn from real statements instead of from retyped names.

Rules the matcher enforces before Claude sees the lines:

- Lines whose `fitid` exists in `transactions.metadata->>'fitid'` are flagged `already_in_ledger: true`
  with the transaction id. Lines matching an existing transaction on the same account within ±2 days,
  same `amount_base` and description trigram similarity > 0.4 are flagged `likely_duplicate` with the
  candidate id. Claude decides `skip` vs `update` for those; default is `skip`.
- Card bill payments ("Pagamento de fatura", "Pagamento recebido") are transfers between the checking
  account and the card liability, never expenses.
- Transfers between own accounts are paired when the counterpart line exists in another parsed statement
  (same amount, opposite sign, ±1 day). When only one side is visible, the plan still books a transfer if
  the description names an own account; otherwise Claude asks.
- Installments on card statements ("Parcela 3/6" or "3/6" in the title) follow `PRODUCT.md`: description
  `<desc> (3 de 6)`, one transaction per installment already present is matched by description + amount.
- Foreign-currency lines keep `amount`/`currency` and fetch the rate from Frankfurter for the line date
  (same endpoint the app uses) to fill `exchange_rate`/`amount_base`.

Balance check after planning: `ledger_opening + Σ(cleared entries) + Σ(plan deltas on that account)`
must equal `closing_balance`. The difference is written to the plan summary; on apply the applier opens a
reconciliation for the statement period, clears every entry a statement line vouched for, lists
outstanding and missing items, and closes it `balanced` when the difference is zero (§8). Any non-zero
difference follows §8.

Attachments from Discord and web uploads follow the same path (`source = upload`), capped at 15 MB, and
land in the conversation where they were posted. Images (receipts, app screenshots) are passed through
untouched; Claude reads them with `Read` in the workspace. Uploads accept any file: one that is not a
parsed statement (a purchase list, an invoice, an unknown format) is stored with `format = other` and no
lines, and the turn message asks the session to read it and check it against the ledger (prompt section
"Other documents"). The empty Advisor screen offers a composer for this: text and files together.

---

# 8. Reconciliation and check-ins

Reconciliation follows standard bank-reconciliation practice, adapted to a personal double-entry ledger.
It is a first-class resource (`reconciliations`, `reconciliation_items`, §5.5), one per account per
statement period, chronological, with continuity between periods.

**Vocabulary.** A ledger entry is *cleared* when a statement line vouches for it. An entry in the period
with no statement line is *outstanding* (timing: a card purchase not yet posted, a PIX scheduled for
tomorrow) and must be explained, not deleted. A statement line with no ledger entry is *missing* and
becomes a `create` plan item. Two entries for one statement line make a *duplicate*. What remains after
all of that is the *difference*; it is never absorbed silently.

**The reconciliation equation** the applier and the advisor both use:

```
difference = statement_closing − (ledger_opening + Σ cleared entries in period)
balanced  ⇔ |difference| < 0.005
```

Outstanding entries are listed, not subtracted: in a personal ledger they are almost always missing or
mis-dated statement lines, so they stay visible until the next statement clears them or the user confirms
they belong to a later period.

**Procedure (statement arrives):**

1. `open_reconciliation` for the statement period. Continuity: the statement's opening balance must equal
   the previous balanced reconciliation's closing balance for that account. If it does not, the advisor
   says so first ("the September reconciliation closed at R$ 1.546,74 but this statement opens at
   R$ 657,21") and works out which side moved before touching anything else.
2. Match each statement line: FITID → exact entry; else same amount within ±2 days and
   `classify_candidates` name evidence → `cleared` candidate; else `missing` → plan item. Each ledger entry
   in the period without a line → `outstanding`. Second entry on an already cleared line → `duplicate` →
   `delete` plan item (Claude marks, the user keeps or drops it).
3. Approve and apply the plan; `set_reconciliation_items`; compute the difference.
4. Zero → `close_reconciliation(balanced)`, `accounts.last_checked` updated, account shows "reconciled
   through <period_end>". Non-zero → stays `open`; the advisor investigates (outstanding items, FX
   rounding on foreign-currency accounts, fees not on the OFX, mis-dated transfers) and reports what it
   found with evidence. Only when the user says "adjust" does it add an `adjust` plan item: a transaction
   `Ajuste de conciliação <account> <period_end>` between the account and the suspense account `ajustes`,
   equal to the difference, and closes the reconciliation as `adjusted` referencing that transaction. If
   the user explains the gap instead, the explanation goes to `notes` and the reconciliation stays `open`
   until a later statement clears it.

**Locking.** Cleared entries belong to a closed period. A plan item that would update or delete a cleared
entry may be flagged `reopens_reconciliation` as a hint; approving the plan is enough — the applier
marks the affected reconciliation `open` again with a note and closes it again after apply when it
still balances (2026-10-15: the old "refuse unless flagged" rule blocked simple recategorisations). The Ledger shows a small check
glyph on cleared rows and, in the expanded row, which statement cleared it and the raw statement text
(mockup board "Ledger · cleared glyph"). Editing a cleared entry in the Ledger asks for confirmation and
reopens the reconciliation the same way.

**Suspense review.** `ajustes` is a suspense account, not a category. When asked (and in a budget
session, unprompted), the advisor lists open `adjusted` reconciliations and the suspense balance per
account, and proposes reclassifying adjustments that a later statement explained.

**Casual check-in** ("Nubank tá com 657,21", in web or Discord): resolve the account via `match_account`
(ask when ambiguous), compute the ledger balance as of today (excluding future-dated installments as
`account_balances` does), and reply with the gap, `reconciled_through`, and the shortest statement period
that would cover the gap (from `reconciled_through + 1` to today). On a zero gap, propose `mark_checked`
(updates `accounts.last_checked`, the only direct write allowed outside a plan, still only after a yes).
On a gap, ask for that period's statement and run the procedure above; no adjustment is ever proposed
from a stated balance alone.

**"No movement" answers** to a stale nudge → `mark_checked` for that account after confirmation.

Never book an adjustment silently, never net two accounts' gaps against each other, never touch hidden
accounts, never close a period whose predecessor is `open` with a non-zero difference without saying so.

---

# 9. Session system prompt (`advisor/prompts/advisor.system.md`)

Start from `mcp-server/ADVISOR_PROMPT.md` (model, sign convention, multi-currency, never invent account
ids, household of two) and add:

1. **You do not write to the ledger.** You draft plans with `plan_*` tools; a human approves and the
   system applies. Never say something was recorded unless `plan_get` shows `applied`.
2. **Plan quality bar:** every item balances to zero in `amount_base`, uses existing accounts, carries a
   `rationale` and a `confidence`, and references its statement line. Prefer `skip` over a doubtful
   `update`. Group a statement into one plan.
3. **Categorise with evidence, not memory.** Call `classify_candidates` with everything you know about
   the line (raw text, amount, account, date, posted time). Use the household's short name from
   `merchant_alias_get` when it exists; otherwise propose a short Title-Case name from the raw text and,
   once the user accepts it, teach it with `merchant_alias_set`. Confidence comes from the tool's margin
   and evidence count, not from your own impression. When the top two candidates are close, ask or pick
   the one with recent evidence and say why.
4. **Reconciliation policy** (§8) verbatim, including continuity, cleared/outstanding/missing vocabulary,
   and "adjust only when told".
5. **Household:** the ledger may be shared by more than one person (account names usually carry an
   owner prefix); ask only when ownership changes the categorisation. Hidden accounts are out of scope.
6. **Language:** answer in the language of the last user message. Keep ledger descriptions and category
   names as they are in the data.
7. **Memory:** before answering about an account, call `note_list`; record durable facts the user states
   with `note_add` ("the Itaú statement arrives on the 5th", "this account is tracked in USD").
   Keep `conversation_summary_set` current when a thread grows long.
8. **Numbers:** always from tools or from Python over the workspace CSVs, never from memory. Dates
   `YYYY-MM-DD`, amounts as decimal units, Brazilian formatting in replies (`R$ 1.234,56`).
9. **Budget sessions:** read `list_budget_items` and `list_budget_monthly_spending`, compute the rolling
   adjustment exactly as `BUDGET_MODULE.md` defines it, and propose changes as `budget_upsert` plan items.

---

# 10. Approval and apply

- Plan states: `draft → pending_approval → approved → applying → applied | failed`, or `rejected`.
  Editing an item while `pending_approval` bumps `version`; approving sends the version the user saw and
  the applier refuses a stale version (same safeguard territorial-assistant learned the hard way).
- **Web:** Plan review page shows items in a table (date, description, entries with account pickers and
  amounts, category chip, confidence, rationale, source line). Inline edit, remove, re-add. A text box
  "ask the advisor to change the plan" sends a message to the same session; Claude revises via
  `plan_set_items`. Approve / Reject buttons.
- **Discord:** the thread post lists the summary (counts by kind, total by account, closing balance
  delta) and a CSV attachment of the items. ✅ reaction or a message like "aprova", "go", "pode
  aplicar" from an obeyed user approves; "rejeita" rejects; any other message is a session turn.
  Approval by reaction is only accepted on the **latest** summary message for that plan version.
- **Applier** (`plan/apply.ts`): runs items in `seq` order, each through PostgREST with
  `p_metadata` provenance (including `statement_line`, which also teaches `merchant_aliases` inside the
  RPC); `update` re-sends full entries; `delete` only for items Claude marked and the user kept; items
  on cleared entries reopen the period automatically; `adjust` as in §8; `budget_upsert`
  → `upsert_budget_item`; `mark_checked` → `PATCH /accounts?id=eq.<id>` with `last_checked = now()`.
  Per-item status and error; partial failure leaves the plan `failed` with applied items recorded, never
  rolled back silently. After apply: `open_reconciliation` + `set_reconciliation_items` +
  `close_reconciliation` when balanced (§8), statement `applied`, Discord/web notification with the final
  balance check and `reconciled_through`.
- Who may approve: in web, any authenticated finances token (`created_by` records which). In Discord, user
  ids in `DISCORD_OBEYED_USER_IDS`.

---

# 11. Web app (`app/`)

- New top-level view **Advisor** in the nav (`Dashboard | Ledger | Accounts | Budget | Advisor`),
  following `DESIGN_GUIDELINES.md`.
- Left: conversation list (title, last activity, unread badge, pending-plan badge). Right: chat with
  streaming replies (SSE), progress lines for tool activity, drag-and-drop or paperclip upload, Enter to
  send, Shift+Enter newline. A "New conversation" button; a conversation created from Discord appears here
  too (channel badge).
- Plan review route `#/advisor/plans/:id` as described in §10; plans awaiting approval also surface as a
  banner on the Dashboard.
- API client `app/src/lib/advisor-api.ts` uses `VITE_APP_ADVISOR_URL` and the same JWT from
  `localStorage` (`finances_auth_token`). The advisor verifies HS256 with `JWT_SECRET`; a 401 triggers the
  existing logout path.
- TanStack Query for lists; SSE via `fetch` + `ReadableStream` (not `EventSource`, which cannot send the
  Authorization header).

---

# 12. Discord

- discord.js v14, intents `Guilds`, `GuildMessages`, `GuildMessageReactions`, `MessageContent`; partials
  for reactions. Guild, channel and obeyed user ids from `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`,
  `DISCORD_OBEYED_USER_IDS`. `advisor/README.md` documents creating the bot application (intents above,
  invite with `Send Messages`, `Create Public Threads`, `Read Message History`, `Add Reactions`,
  `Attach Files`). Discord is optional: with `discord` absent from `ADVISOR_CHANNELS` the bot never starts.
- Behaviour: one thread per statement/plan ("Nubank conta · 01–11 out 2026") and per ad-hoc question
  started in the channel. Messages in a thread are session turns of that conversation. Attachments are
  downloaded (15 MB cap) into the conversation as uploads. Replies are chunked at 2000 chars; long
  tables go as files.
- Nudges: `jobs/nudges.ts` lists the top-level, non-hidden accounts with `check_due` (view
  `account_check_status`, migration 0057 — see "Balance-check cadence" in API_CONTRACT.md) with balance and
  why each is due. It posts when an account newly becomes due (not in the previous nudge), otherwise at
  most once a week while accounts stay due, never twice a day. (Superseded the flat 30-day `STALE_DAYS`
  rule on 2026-10-15.) `jobs/pending-plans.ts` reminds once a day about plans pending more than 24 h.
- `catchUp()` on boot replays obeyed-user messages and reactions missed while down (query channel and
  thread history since `advisor_state.discord_last_seen`).

---

# 13. Gmail watcher

- The operator's mailbox, via a Google Cloud OAuth desktop client with an offline refresh token
  (`advisor/ops/gmail-auth.mjs` guides the one-time consent flow and prints the refresh token; env
  `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`). Scope `gmail.readonly`, plus
  `gmail.modify` only if labels are used. Gmail is optional: with `gmail` absent from `ADVISOR_CHANNELS`
  the watcher never starts.
- Walk `users.history` from `advisor_state.gmail_history_id` every cheap tick (first run: 14 days of
  `has:attachment`). Rules first, Sonnet `route-mail` only for unknown senders with attachments:

| Match | Result |
|---|---|
| from `todomundo@nubank.com.br`, subject contains `Extrato da sua conta do Nubank` | institution `nubank`, kind `account`; take `.ofx` (primary), keep `.csv`/`.pdf` |
| from `todomundo@nubank.com.br`, subject contains `Extrato da fatura do Cartão Nubank` | institution `nubank`, kind `card`, `.csv` |
| from `noreply@wise.com`, statements | institution `wise`, kind `account`, pdf/csv |
| other with pdf/ofx/csv attachment | Sonnet routes to one of `statement`, `invoice`, `ignore` with an institution guess; `statement` → ingest, else ignore |

- Which ledger account a statement belongs to is decided by the account number in the OFX (`ACCTID`)
  or the card CSV filename, mapped through `advisor_notes` (scope `account`, note
  `statement_source=<institution>:<acctid>`); when unknown the session asks once and records the note.
  Only one mailbox is watched; statements from other household members arrive as uploads.
- Mailed statements are grouped per account: the conversation is picked after parsing
  (`external_ref` `gmail:<account_id>`, or `gmail:<institution>:<kind>` until the account is known) and
  reused while no turn has run in it; its title spans the periods. The background job starts a
  conversation's planning turn only when its newest statement is 3 minutes old, so an initial sync or a
  burst of re-sent mails is planned in one turn that walks the periods oldest first, one plan per period,
  checking continuity between consecutive periods (`buildPlanningMessage`). "Planejar agora" and the
  manual pick-up skip the wait.
- Idempotency by `gmail_message_id` + attachment `sha256`. Label processed messages
  `finances/processed` when `gmail.modify` is granted.

---

# 14. Deployment

## 14.1 Image

`advisor/Dockerfile`: multi-stage on `node:22-bookworm-slim`; final stage installs `python3`,
`poppler-utils`, `ca-certificates`, `git` (Claude Code expects it), then
`npm i -g @anthropic-ai/claude-code@<pinned>`; creates user `advisor`, `WORKDIR /app`, copies the built
`dist/` and `prompts/`, `HEALTHCHECK` on `GET /health`, `USER advisor`, `CMD ["node","dist/main.js"]`.
`.github/workflows/advisor-image.yml` builds on pushes to `main` touching `advisor/**` and pushes
`ghcr.io/<repo-owner>/finances-advisor:latest` and `:sha-<short>` using the workflow's `GITHUB_TOKEN`
(no extra secrets, works for any fork). An operator may mirror to another registry.

## 14.2 Self-hosting with the repo's `compose.yaml`

Add an `advisor` service to the existing root `compose.yaml` (next to `db`, `app`, `postgrest`), built
from `advisor/Dockerfile`, with safe local defaults and the same `.env` override mechanism:

```yaml
  advisor:
    build: { context: ., dockerfile: advisor/Dockerfile }
    environment:
      TZ: ${TZ:-UTC}
      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD:-postgres}@db:5432/finances
      POSTGREST_URL: http://postgrest:3000
      FINANCES_TOKEN: ${FINANCES_BOOTSTRAP_TOKEN:-local-dev-login}
      JWT_SECRET: ${JWT_SECRET:-local-docker-jwt-not-for-production}
      PUBLIC_WEB_ORIGINS: ${APP_ORIGIN:-http://localhost:8080,http://127.0.0.1:8080}
      ADVISOR_CHANNELS: ${ADVISOR_CHANNELS:-web}          # add discord,gmail when configured
      DISCORD_BOT_TOKEN: ${DISCORD_BOT_TOKEN:-}
      DISCORD_GUILD_ID: ${DISCORD_GUILD_ID:-}
      DISCORD_CHANNEL_ID: ${DISCORD_CHANNEL_ID:-}
      DISCORD_OBEYED_USER_IDS: ${DISCORD_OBEYED_USER_IDS:-}
      GMAIL_CLIENT_ID: ${GMAIL_CLIENT_ID:-}
      GMAIL_CLIENT_SECRET: ${GMAIL_CLIENT_SECRET:-}
      GMAIL_REFRESH_TOKEN: ${GMAIL_REFRESH_TOKEN:-}
    ports:
      - "${ADVISOR_PORT:-3100}:3100"
    volumes:
      - advisor_claude:/home/advisor/.claude      # Claude Code login + sessions
      - advisor_data:/data                         # statements, workspaces
    depends_on:
      postgrest: { condition: service_started }
volumes:
  advisor_claude:
  advisor_data:
```

The UI build gets `COMPOSE_VITE_APP_ADVISOR_URL` (default `http://localhost:3100`) the same way it gets
the API URL. Document every variable in the `compose.yaml` banner and `compose.env.example`.

## 14.3 Reverse proxy

Any TLS-terminating proxy works. SSE needs response buffering off (Caddy: `flush_interval -1`; nginx:
`proxy_buffering off`). The advisor must be reachable from the browser origin listed in
`PUBLIC_WEB_ORIGINS`.

## 14.4 First-run runbook (in `advisor/README.md`)

1. `python scripts/generate_token.py "advisor"` against the target database → `FINANCES_TOKEN`
   (or reuse `FINANCES_BOOTSTRAP_TOKEN` locally).
2. Start the stack; `GET /health` reports `claude: not logged in`.
3. `docker compose exec -it advisor claude login` → open the URL on any device → `/health` turns green.
4. Open the app's Advisor view, send "hi"; a reply streams. Upload a statement; a plan appears.
5. Optional: configure Discord (§12) and Gmail (§13), add them to `ADVISOR_CHANNELS`, restart.
6. Re-auth when `/health` or Discord says the token expired: repeat step 3.

---

# 15. Configuration (`advisor/src/config.ts`)

All required unless defaulted: `DATABASE_URL`, `POSTGREST_URL`, `FINANCES_TOKEN`, `JWT_SECRET`,
`PUBLIC_WEB_ORIGINS`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`,
`DISCORD_OBEYED_USER_IDS`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`,
`ADVISOR_CHANNELS` (default `web,discord,gmail`), `ADVISOR_ENV`, `PORT` (3100), `MCP_PORT` (3101),
`DATA_DIR` (`/data`), `CLAUDE_BIN` (`claude`), `SESSION_MODEL` (`opus`), `ROUTINE_MODEL` (`sonnet`),
`SESSION_EFFORT` (`high`), `SESSION_TIMEOUT_MS` (900000), `MAX_CONCURRENT_SESSIONS` (2), gate thresholds
(§6.1), `UPLOAD_MAX_MB` (15), `TZ`. Discord and Gmail variables are required only when
their channel is listed in `ADVISOR_CHANNELS`; `config.ts` enforces that conditionally.

---

# 16. Security

- Web API: HS256 JWT from the app, verified with `JWT_SECRET`; `role` must be `authenticated`. CORS
  limited to `PUBLIC_WEB_ORIGINS`. Uploads validated by magic bytes and size.
- Discord: only `DISCORD_OBEYED_USER_IDS` are acted on; everyone else is ignored silently.
- Claude child: no secrets in env, read-only tools, Bash limited to `python3`, `pdftotext`, `ls`, `head`,
  `wc`; cwd is the per-conversation workspace; `--add-dir` only that workspace. The container has no SSH
  keys and no Docker socket.
- PostgREST writes use a dedicated `auth_tokens` row (`advisor`) so they can be revoked independently.
- Provenance on every write; plan audit (`created_by`, `approved_by`, versions); Claude call log.

---

# 17. Delivery plan (for the implementing agent)

Each phase ends with passing vitest suites and the listed acceptance check against `finances-dev`.
Follow `RULES.md` (TDD for parsers, matcher, gate, plan schema), log each session in
`IMPLEMENTATION_LOG.md`, and record open items in `LEDGER.md`.

**Phase 0 — foundation.** Migrations 0047–0051 (provenance, advisor tables, `ajustes`, derived
classification, reconciliations), each with SQL-level tests (pgTAP or a vitest suite against a throwaway
database) covering `normalize_merchant` fixtures, `classify_candidates` on a seeded history (the Tampopo
case: raw `TAMPOPO ALIMENTOS LTDA` and short `Tampopo` must yield one category), and the reconciliation
equation. `advisor/` skeleton, config, logger, pg, PostgREST client, credentials/usage/gate, runner
(session + single-shot) with stream parser, MCP server with read tools + `plan_*`/`note_*`/`statement_*`/
`reconciliation_*`/`merchant_alias_*`/`classify_candidates`, Dockerfile, CI workflow.
Accept: `node dist/main.js` boots with `ADVISOR_CHANNELS=web`; a scripted session asks "qual o saldo da
conta X?" and answers from `list_account_balances`; `advisor_claude_calls` has the row; the web app's
Quick Entry autocomplete and category suggestion still work against the redefined RPC and view.

**Phase 1 — ingestion, plans and reconciliation via web.** OFX/CSV/PDF parsers, matcher (FITID, alias,
candidates), statement storage, workspaces, `jobs/ingest-statement.ts`, HTTP API, applier with
reconciliation open/items/close, Advisor view and plan review in `app/` (per the approved UI design, §20),
the cleared glyph on Ledger rows and the reconciliation lines on Accounts cards (seventh mockup board).
Accept: upload a real Nubank account OFX against a dev database; the plan lists every line not already
in the ledger, pairs the card payment as a transfer, shows alias-based short names where known, and its
summary shows the difference; approve → a `balanced` reconciliation exists for the statement period,
`account_balances.reconciled_through` equals the statement end date, `account_balances.balance` as of
that date equals the OFX `LEDGERBAL`; re-uploading the same file creates no new items (all
`already_in_ledger`); a second statement whose opening balance disagrees with the first's closing is
reported as a continuity break before any plan. Add fixture statements (anonymised OFX/CSV) under
`advisor/test/fixtures/` so the suite runs for anyone.

**Phase 2 — Discord and Gmail.** Bot, threads, ✅ approvals, attachments, catch-up; Gmail history
walker, Nubank rules, Sonnet routing; casual check-ins; `mark_checked`.
Accept: a Nubank statement email arriving in the watched mailbox produces a Discord thread with a plan
summary within one cheap tick; "Nubank tá com 657,21" in the channel gets the gap and last matched date;
✅ on the latest summary applies the plan and the thread reports the final balance check.

**Phase 3 — advisor behaviours, classification audit and legacy cleanup.** Stale-account and
pending-plan nudges, budget sessions with `budget_upsert` plan items, notes memory, conversation
summaries, Claude health job, suspense review, §19, and the **classification audit** (§21.5): a routine
session that finds merchants split across categories or spelled several ways and proposes
recategorisation and rename plans.
Accept: an account with `last_checked` 31 days old triggers exactly one nudge per day; "quero planejar o
orçamento de 2027" produces a `budget_upsert` plan from real `budget_monthly_spending` numbers; the
Dashboard budget card shows the advisor's budget health instead of the piggy bank; the audit on the
maintainer's dev copy proposes a plan for the known split merchants and, after approval,
`classify_candidates` for those raw texts returns one category with confidence ≥ 0.8.

**Phase 4 — maintainer cutover.** Appendix A. Generic steps: create the `advisor` token on the production
database, point the production instance at `ADVISOR_CHANNELS=web,discord,gmail`, publish the proxy route,
set the UI's advisor URL, log in, run the runbook.

---

# 18. Open items (mirror in `LEDGER.md`)

- Headless OAuth refresh inside Docker has no precedent in the maintainer's projects; the health job and
  runbook are the mitigation. If refresh proves unreliable, revisit the API-key fallback declined for v1.
  Check the subscription terms for unattended use before production.
- `ajustes` is an expense account because `daily_balances.net_worth` includes equity. Revisit together.
- Classifier weights (§21) start from reasoned defaults; tune them against the maintainer's history once
  `statement_line.raw` exists on enough transactions, and record the chosen values in `global_settings`.
- Only one mailbox is watched; other household members' statements arrive as uploads.
- The remote MCP Worker (`mcp-server/`) stays for Claude.ai use and gains nothing from this work; consider
  pointing it at the advisor's read tools later to avoid two tool catalogs.

---

# 19. Legacy cleanup and agent-first budgeting

The maintainer reports parts of the app that no longer make sense and a Budget module that was never
really used because keeping it tuned by hand was too much work. The advisor is the fix: budgeting
becomes something you *talk through*, and the module's screens become the place where the result is
reviewed.

The implementing agent must, in Phase 3:

1. **Inventory legacy concepts.** Grep the app, migrations and scripts for concepts that predate the
   ledger model (piggy-bank progress art, unused settings, dead RPC parameters, orphan views). Produce
   the inventory as a section in `IMPLEMENTATION_LOG.md` with one line per item: where it is, whether
   data depends on it, proposed action (remove, fold into the advisor, keep). Apply the removals that
   have no data dependency in the same phase; schema removals follow `MIGRATION_STRATEGY.md` (no drops
   of tables or columns; deprecate views by replacing them).
   Already checked on 2026-10-14: the maintainer's Excel-era **"centro de custo"** (cost centre) never
   reached the database. No table, column, account, alias, setting or metadata key carries it (the only
   matches in `description_memories` are merchant names such as "FARMACENTRO"), and the spreadsheet is
   not tracked in git. No migration is needed for it; `scripts/import_excel.py` must simply never map
   that column.
2. **Replace the piggy bank** (`Dashboard.tsx` `PiggyBankIndicator`) with an advisor-driven budget health
   card: period remaining, months left, the two categories most over and under target, and a "Review
   with the advisor" action that opens a conversation seeded with the budget context.
3. **Agent-first budget flow.** The Planning wizard stays as the manual editor, but its empty state and
   the Budget header get an "Plan with the advisor" entry point. A budget session reads real
   `budget_monthly_spending` and `get_category_monthly_history`, proposes a complete plan (`period_amount`,
   `min_pct`, `max_pct`, `category_type` per category) as `budget_upsert` items with rationale, and the
   user adjusts by talking ("menos 10% em alimentação externa", "fixa o aluguel"). Approval applies it
   through `upsert_budget_item`. Monthly, when the gate is open, the advisor can post a budget review to
   Discord only if `ADVISOR_BUDGET_REVIEW=true` (default off, consistent with "nudges only on arrival or
   staleness").
4. **Keep the ledger model untouched.** Nothing here changes `accounts`, `transactions`, `entries` or the
   invariants.

---

# 20. UI/UX design (approved)

The Advisor view was designed as a clickable mockup before any code (Design artifact "Finances Advisor
UI") and **approved as designed by the maintainer on 2026-10-14**. The implementing agent follows that
design; the summary below is the contract. Any later UI change goes back to the mockup first. The two
reconciliation touches in existing views (cleared glyph on Ledger rows, reconciled-through and suspense
lines on Accounts cards) were added to the mockup the same day as a seventh board; implement them as
drawn.

- **Placement:** fifth tab `Advisor` in the top nav (`Dashboard | Ledger | Accounts | Budget | Advisor`),
  same pill style and icon weight as the others (lucide `Sparkles`).
- **Layout (desktop ≥ 1024 px):** two panes. Left 280 px: conversation list grouped `Needs you` (plans
  pending approval, questions waiting), `Recent`, `Archived`; each row shows title, channel badge
  (web/Discord/Gmail), relative time, and a small amber dot when a plan awaits approval. "New
  conversation" button at the top. Right: the conversation.
- **Conversation:** header with title, channel badge, linked statement chips, and an overflow menu
  (rename, archive, open in Discord). Messages: user bubbles right-aligned in `bg-white/[0.06]`;
  advisor messages full-width plain text with Markdown, tables rendered in mono. Tool activity shows
  as a collapsed single line under the streaming message ("Reading 142 lines · checking balance as of
  30 Sep") that expands on click; it fades to a 1-line summary when the turn ends. Composer at the
  bottom: textarea (Enter sends, Shift+Enter newline), paperclip upload, drag-and-drop over the whole
  pane, and a "Stop" button while streaming.
- **Plan card (inline in the conversation):** appears when a plan reaches `pending_approval`. Shows
  title, counts by kind (create/update/skip/adjust), total by account, closing-balance check (✓ or the
  delta in red), and buttons `Review`, `Approve`, `Reject`. Approve on the card is allowed only when the
  balance check is ✓ and no item is below 0.6 confidence; otherwise `Review` is the primary action.
- **Plan review (right pane replaces the chat, with a back arrow):** dense table in the Ledger's visual
  language: date · description · account → category chips · amount (mono, red/green) · confidence bar ·
  status. Row click expands the double-entry lines and the source statement line. Inline edits:
  description text, category picker (`SearchableSelect`, existing component), account picker, amount,
  date; remove/restore row; `skip ↔ create` toggle. A sticky footer holds: balance check (live, recomputed
  on edits), "Ask the advisor to change this plan…" input (sends a turn; the table updates when
  `plan_set_items` runs), `Reject`, `Approve N items`. Edited rows are marked and bump the plan version.
- **Dashboard hooks:** a slim banner under the nav when plans await approval ("2 plans waiting ·
  Review"); the budget health card from §19.
- **Mobile (< 1024 px):** single pane; the conversation list is a slide-over; the plan review table
  collapses to cards (description + amount on the first line, category and account chips below). All
  actions reachable with the thumb: composer and approve bar pinned to the bottom.
- **States:** empty conversation list (short explainer + three starter prompts: "Importar extrato",
  "Conferir saldo", "Planejar orçamento"); Claude not logged in (banner with the runbook step); gate
  closed for background work (badge on the Gmail-sourced conversation: "waiting for a quiet window").
- **Motion and style:** `DESIGN_GUIDELINES.md` throughout: Geist, dark first, `border-white/10`,
  `backdrop-blur` header, `active:scale-[0.99]`, 300 ms transitions on pane changes and row expansion.

---

# 21. Classification: from description memories to derived, multi-factor matching

## 21.1 Why the current mechanism fails

`description_memories` was built for a human typing short names: one row per normalized description,
updated on every write, matched by trigram similarity, boosted by usage and recency. Two things broke it:

- **Two names for one merchant.** Statements say `TAMPOPO ALIMENTOS LTDA`; the household says `Tampopo`.
  Agents recomposing statements wrote both forms, so the same place has two memories, and the trigram
  match can land on a third, unrelated memory that happens to share letters.
- **Stored state drifts.** A memory is overwritten by the last write, so one wrong categorisation
  poisons every future suggestion for that name, and there is no evidence trail to show why a
  suggestion was made.

The fix follows the same principle as balances: **nothing is stored that can be derived.** Suggestions are
computed at query time from the ledger itself, over several factors, with the evidence returned alongside
the answer. The only stored thing is a fact the user actually taught: "this raw statement text is this
merchant" (`merchant_aliases`).

## 21.2 Inputs

Every transaction created from a statement carries `metadata.statement_line.raw` and `posted_at`
(§7). Transactions typed by hand carry only their description. The `transaction_lines` view (§5.4)
exposes, per category entry: `norm_description`, `norm_raw`, `amount_base`, `category_id`,
`asset_account_id`, `date`, `posted_at`, and a recency weight.

## 21.3 `classify_candidates`

```
classify_candidates(p_description, p_amount, p_account_id, p_date, p_posted_at, p_raw, p_limit)
```

1. **Alias short-circuit.** If `p_raw` is given and `normalize_merchant(p_raw)` exists in
   `merchant_aliases`, the canonical description is fixed and name similarity is computed against it
   with weight 1.0 (`factors.alias = true`). The category still comes from evidence below, so a merchant
   that genuinely moves between categories (a supermarket that sometimes sells `casa:upgrades`) still
   shows both.
2. **Per-transaction factors** over `transaction_lines` from the last 24 months (`classifier_history_months`):

   | Factor | Definition | Default weight |
   |---|---|---|
   | `name` | `greatest(similarity(norm_description, norm_input), word_similarity(...))`, plus the same against `norm_raw` when both sides have raw text | 0.40 |
   | `raw` | `similarity(norm_raw, normalize_merchant(p_raw))` when both present, else 0 | 0.20 |
   | `amount` | 1.0 if equal to the cent; 0.7 if within 10 %; 0.3 if same order of magnitude; else 0 | 0.15 |
   | `account` | 1.0 if the historical asset/liability account equals `p_account_id`; else 0 | 0.10 |
   | `time` | `0.5·same_weekday + 0.3·same_day_of_month(±1) + 0.2·hour_within_2h` (hour term only when both `posted_at` present) | 0.10 |
   | `recency` | `exp(−days_since / 365)` multiplies the transaction's total | — |

   A transaction counts only if `name ≥ 0.25` or `raw ≥ 0.6`. Weights live in
   `global_settings.classifier_weights` (JSON) and are read at call time.
3. **Aggregate per category:** `score = Σ(top-k transaction scores × recency) × log1p(n) / log1p(k)`
   with `k = 8`, so a merchant with 40 consistent entries beats one with 2 but not by 20×.
   `canonical_description` = the modal description among that category's matches (tie → shortest).
   `factors` = averages of each factor over the matches plus `n_matches`, `last_seen`, `alias`.
4. **Confidence** = `(score₁ − score₂) / score₁` blended with evidence: `confidence = 0.7·margin +
   0.3·min(1, n_matches₁ / 5)`. Single-candidate results cap at 0.9. The plan review's confidence bar
   shows this number; the approve gate uses it (§10).
5. Returns the top `p_limit` rows ordered by score.

`match_description_memory(p_input)` becomes `classify_candidates(p_input, …)` reshaped to its old
columns, so Quick Entry's live suggestion improves without a frontend change.

## 21.4 Learning

- **Aliases** are written only by `create_transaction`/`update_transaction` when `statement_line.raw` is
  present (the household's accepted description for that raw text), by `merchant_alias_set` from a
  session after the user agreed, or by the audit (§21.5) after approval. `hits` increments on reuse.
- **Nothing else is stored.** Changing a transaction's category changes future suggestions immediately,
  because suggestions are computed from transactions.
- Hand-typed Quick Entry transactions keep participating through their descriptions, so the household's
  short names keep weight even without raw text.

## 21.5 Classification audit (routine, gated, Phase 3)

A Sonnet-planned, Opus-reviewed session that runs when asked or monthly:

1. Finds merchants (by alias or by `norm_description` cluster with similarity > 0.6) whose transactions
   spread over more than one category where the minority share is under 25 %, and merchants spelled in
   more than one way (raw-like and short).
2. Proposes a plan: `update` items that move the minority transactions to the majority category (with the
   evidence per item), rename items that unify spellings to the short form, and `merchant_alias_set`
   teachings for the raw forms.
3. The user approves per plan as usual. Nothing is auto-applied.

## 21.6 What this means for the web app

- Quick Entry: unchanged API, better suggestions; later it can show the top-2 with confidence.
- Plan review: each row shows the raw text, the proposed short name, and the top candidate's evidence
  ("12 × alimentacao:basica, same amount range, Tue/Thu") in the expanded panel.
- Accounts page: `reconciled_through` (green check when current, amber clock with the open gap when a
  reconciliation is open) and the suspense balance per asset/liability card, plus a link that opens an
  advisor conversation for the next period (mockup board "Accounts · reconciled through + suspense").

---

# Appendix A. Reference deployment (the maintainer's instance)

Non-normative. Shows one way the generic pieces map onto an existing self-hosted setup; nothing here is
required to run the advisor.

- The maintainer runs Postgres and three PostgREST containers (prod, dev, a company ledger) on a home
  server behind a Portainer git stack, publishes them through Caddy on a small public VM, hosts the React
  app on Cloudflare Pages and the MCP Worker on Cloudflare Workers. Compose files and Caddy config live
  in a private infrastructure repo.
- The advisor is added to that stack as two services (`finances-advisor-dev`, `finances-advisor`),
  each with its own `.claude` and `/data` volumes, pointing `POSTGREST_URL` at the matching PostgREST
  container on the stack network and `DATABASE_URL` at the matching database. Secrets are Portainer stack
  variables (`${VAR:?}`). Only the active instance lists `discord,gmail` in `ADVISOR_CHANNELS`.
- Caddy gets two routes (`advisor-finances-dev.<domain>`, `advisor-finances.<domain>`) with
  `flush_interval -1`; DNS points at the public VM; the Pages project gets `VITE_APP_ADVISOR_URL`.
- Discord: the maintainer reuses an existing private guild and bot application during the pilot and
  rotates the bot token at production cutover; the token is stored only as a stack variable.
- Deploy by pushing the infra repo and redeploying the stack with image re-pull; verify `/health`.
