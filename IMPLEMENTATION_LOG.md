# IMPLEMENTATION_LOG.md

## 2026-10-15 — Production cutover (fresh start)

- PR #6 merged into `main` (9feef58). Production database backed up (`finances-20261015-102526-pre-advisor.dump` on the host) and migrated 0047–0054 in place; no advisor data was promoted from the dev copy (the maintainer wanted a clean start).
- Production service `finances-advisor` (image built from `main`, `ADVISOR_ENV=prod`, port 4100, own data volume, shared Claude login, channels web + discord + gmail, a new Discord channel, only the maintainer's user id obeyed, Gmail credentials moved from dev). Route `advisor-finances.marotta.dev`; `VITE_APP_ADVISOR_URL` set on the Pages production environment and a production build triggered. The dev instance keeps running web-only against `finances-dev`.
- First production sync: 25 mails, six Nubank account statements (Jun, Jul ×2, Aug, Sep, Oct 1–11) parsed in their own conversations, CSV/PDF duplicates skipped; planning turns wait for the usage gate (the 5-hour window was at 81% after the day's work).
- "Planejar agora": with the usage gate closed every mailed statement sat waiting. `POST /conversations/:id/plan-now` and `POST /conversations/plan-now` start the planning turn(s) immediately as interactive turns (never gated); conversation rows carry `waiting_turn`; the web app shows a card with the button on a waiting conversation, an "agora" shortcut on each waiting row and a "Planejar N extratos agora" button above the list. The background job and the manual path share `findWaitingStatements` / `startPlanningTurn`.
- Found on the first tick and fixed: the stale-accounts nudge crashed because pg returns `last_checked` as a Date (`isoDay`/`movedSinceCheck`, unit-tested); the background job now marks re-sent statements (same institution, kind and period as an earlier one) `ignored` and archives their empty conversation before planning, so one period gets one turn.

## 2026-10-15 — Advisor: first review feedback (Discord for mobile, dashboard CTA, accounts from plans)

### What was implemented
- **Discord redesigned for a phone.** One short *tracker* message per topic in the channel, edited in place as the topic moves along (`⏳ Pensando…` → `✅ Respondido · <headline>`; `🟡 Plano aguardando aprovação` → `⏳ Aplicando…` → `✅ Aplicado · N lançamentos · conciliação fechada até dd/mm`, or `❌ Plano rejeitado`); everything else in the topic's thread. Replies pass through `formatReply` (tables → code blocks, one paragraph per line, headings bold) and the system prompt tells the assistant to answer Discord turns in a few lines, offering detail on request. ✅ approves on the thread summary or on the tracker. The CSV attachment is gone; `WEB_APP_URL` (optional) adds a deep link to the plan. Daily nudges became `Notice`s (tracker + list in the thread; same key same day edits instead of re-posting), and the nudge thread is a conversation with the nudge as hidden context so replies run the check-in. `advisor/src/discord/{bot,poster}.ts`, `src/notify.ts`, `src/jobs/nudges.ts`, `src/config.ts`.
- **Accounts from the advisor.** Plan item kinds `account_create` (`payload {ref, name, type, subtype, parent_id?}`; later items use `account_id: "new:<ref>"`) and `account_update` (`{account_id, name?, subtype?, parent_id?, icon?, color?, hidden?}`), validated against the ledger (slug names, subtype fits the type, parent type, no duplicate full name, placeholder declared earlier) and applied through `POST/PATCH /accounts` with placeholder substitution before entries are posted. Migration 0052 widens the kind check and adds account subtypes `property` (asset) and `loan` (liability), which the dashboard already leaves out of the money cards and net worth. Prompt section "Accounts and subtypes" tells the assistant to put the account in the plan instead of sending the person to the app, and never to use `hidden` for that. `src/plan/{schema,apply}.ts`, `src/postgrest/client.ts` (`post`), `src/mcp/tools/{advisor,ledger-read}.ts`, `prompts/advisor.system.md`.
- **Dashboard call to action.** `AdvisorCta` under the balances, shown only when the advisor is reachable and there is something to do: accounts that moved after their last check, accounts unchecked for 30+ days, uncategorised entries (`sem-categoria`) in the selected range. Each row opens a conversation with the right message and hidden context. `app/src/lib/advisor-reasons.ts`, `app/src/components/advisor/AdvisorCta.tsx`.
- **App.** Account form offers `property` / `loan` with a one-line explanation; plan review renders account items (label, payload) without a money column.
- **Docs.** `advisor/README.md` (Discord behaviour, accounts, `WEB_APP_URL`), `docs/ADVISOR.md` kinds, `docs/API_CONTRACT.md` subtypes, `docs/DOMAINS.md` accounts fields, `LEDGER.md` Gmail steps, compose files.
- **Found while verifying on the dev instance.** (1) A resumed Claude session kept answering that it could not create accounts after the capability shipped: conversations now store a hash of the prompt + tool-set version (migration 0053, `CAPABILITIES_VERSION`); on a mismatch the turn starts a fresh session with the last twelve turns as transcript instead of resuming. (2) `update_transaction` recreates entries, which cascaded away their reconciliation clearings, so every recategorisation of a reconciled line left the period open with a stale total: `src/plan/clearings.ts` snapshots the clearings before an update, re-attaches them to the new entries (same account, same amount when possible), recomputes `cleared_total`/`difference` from the ledger and closes the reopened period again (`balanced` on zero difference, `adjusted` again when its adjustment still fits; otherwise it stays open and the result says so). Covered by the SQL suite.

### Why
Review of the first day on the dev instance: Discord messages were long walls of text unreadable on a phone and the channel had no state; the advisor told the user to create the house asset account in the app and said it could not post to hidden accounts (the right tool was a subtype, not `hidden`); the dashboard had no entry point when the ledger needed attention.

### Tests
`advisor/`: 70 tests (new: account item validation and placeholders, `mobileify`/`headline`/tracker build+parse, clearings carried across `update_transaction` + re-close decision in the SQL suite). `app/`: 60 tests (new: `advisorReasons`), build clean, lint parity.

### Gmail
`advisor/ops/gmail-auth.mjs` now reads the downloaded client JSON (`--client-json`), prints the redirect URI a Web client would need, and writes the three variables to `~/.config/finances-advisor/gmail.env` (mode 600) instead of the terminal. The maintainer's mailbox was connected with a Desktop client; the dev advisor runs `ADVISOR_CHANNELS=web,discord,gmail` and its first sync (25 messages, 14-day lookback) picked up a Nubank account statement mail (OFX + CSV attachments) into a system conversation for a gated background planning turn.

### Classifier speed (migration 0054) and Gmail pick-up
The first Gmail sync showed every statement attachment taking 70+ s: `classify_candidates` took ~2.9 s per line on the real history (the `transaction_lines` view normalized every row and all rows were scored). Migration 0054 stores the normalized texts as generated columns with pg_trgm GIN indexes and pre-filters the scorer with `%`/`<%` at the eligibility threshold; verified on the dev copy that the pre-filter keeps every previously eligible row (78/78) and the call now takes ~0.14 s. The Gmail sync ingests only the preferred attachment of a statement mail (OFX before CSV before PDF) unless it yields no lines, logs each handled mail, and the web API gained `GET /gmail/messages?q=` and `POST /gmail/messages/:id/ingest` for manual pick-up (interactive turn, not gated).

### Phone navigation (review feedback)
At 390 px the five-tab pill switcher overflowed the header (two tabs visible, logout off-screen). Phones now get a fixed bottom tab bar (icons + short labels, safe-area padding, `viewport-fit=cover`), the header keeps logo and logout, desktop keeps the pill; the Advisor pane uses `100dvh` minus header and bar on phones; the dashboard date presets wrap. Verified with Playwright screenshots at 390×844 and 1280×800.

### Plain Portuguese everywhere (review feedback)
The maintainer is not an accountant nor technical and reads Portuguese. The system prompt's style section became "Como você fala com a pessoa": plain pt-BR, a list of banned words (ledger, skip/create/update, entries, FITID, ids, tool names, versions, balanced/open…) with the everyday phrasing to use instead ("já estava registrado", "conferência do extrato", "o saldo bate", "patrimônio, que não conta como dinheiro no painel"), one question at a time, dates and money in Brazilian format, no code formatting; `CAPABILITIES_VERSION` bumped so old sessions restart with it. Discord trackers, plan summaries, nudges, apply results and the re-auth alert were reworded ("🟡 Esperando sua aprovação", "✅ Gravado · 4 lançamentos", "Extrato conferido até 30/09: o saldo bate"). The web Advisor screens (conversation list, chat, plan cards, plan review, item rows, banners, empty/offline states), the tool-progress lines ("procurando a categoria de “Tampopo”"), error messages, the budget health card, the reconciliation lines on Accounts and the cleared-entry texts on the Ledger are in plain Portuguese; item kinds show as "novo / correção / excluir / já registrado / ajuste / nova conta"; identifiers such as FITID are no longer shown. The nav tab keeps the name "Advisor"; the rest of the pre-existing app (Dashboard, Ledger, Accounts, Budget labels) stays in English for now.

### Gmail pick-up of the card statement (dev copy)
The mailbox holds "Extrato da fatura do Cartão Nubank" mails with `Nubank_YYYY-MM-DD.csv` (2 and 10 Sep), older than the 14-day first-sync window, so the watcher had not seen them; `GET /gmail/messages?q=` lists them as `nubank card`. `POST /gmail/messages/<10 Sep mail>/ingest` parsed 98 lines in ~10 s (after migration 0054) and the interactive turn resolved the account to `victor-nu-cartao` from the instalment history (the CSV carries no account number, recorded as a `statement_source` note), produced one plan with 98 skips and 6 deletes of duplicates typed twice on 1 Sep, and flagged that the export covers only 1–10 Sep of the bill due 8 Oct. The background job meanwhile planned the June and July account statements from the first sync (29 and 25 skips, reconciliations `balanced`). The maintainer approved all three from the web preview. Two empty drafts remain from mails whose lines were all already in the ledger (see LEDGER.md).

### Acceptance on the dev copy
Fresh web conversation "Conta do imóvel" → one plan with `account_create casa-imovel (asset/property)` + three `update` items referencing `new:casa`; Discord got the tracker ("🟡 Plano aguardando aprovação · 3 alterações · 1 conta", deep link) with the compact summary in its thread; approval through the API created the account (subtype `property`, not hidden, 3 entries) and moved the three transactions. The September reconciliation had been left open by the earlier Hussein recategorisation (the clearings bug above); it was repaired on the dev data and the fix ships with this entry.

---

## 2026-10-14 — AI Finances Advisor: implementation (phases 0–3) and dev deployment

### What was implemented
Everything in `docs/ADVISOR.md` §17 phases 0–3, on branch `advisor`, as one PR to `main`.

- **Migrations 0047–0051.** `create_transaction`/`update_transaction` accept `p_metadata` (provenance, FITID/source indexes); `advisor_*` tables; `ajustes` suspense account; derived classification (`merchant_aliases`, `normalize_merchant`, `transaction_lines`, `classify_candidates`; `match_description_memory` and `description_memories_with_names` keep their shapes and are now derived; `learn_from_transaction` replaces the memory block); reconciliations (`reconciliations`, `reconciliation_items`, `entry_clearings`, `account_reconciliation_status`, `open_/set_/close_/reopen_reconciliation`, `ledger_balance_as_of`, `uncleared_entries`; `account_balances.reconciled_through/cleared_balance`; `transactions_with_entries.clearing`).
- **`advisor/` daemon** (Node 22, Hono, pg, zod, discord.js, pino): config with the prod/dev database guard, Claude credentials/usage/gate (routine only), `claude -p` runner with stream-json parser and fake-claude tests, session pool (interactive slots, one yielding background slot) and per-conversation locks, local Streamable-HTTP MCP server with per-run bearer tokens (read tools mirroring `mcp-server/` plus `classify_candidates`, `merchant_alias_*`, `statement_*`, `reconciliation_*`, `uncleared_entries`, `note_*`, `plan_*`, `conversation_summary_set`), ingestion (own OFX SGML/XML parser, Nubank account/card CSV, pdftotext fallback, detection, matcher with FITID/likely-duplicate/alias/candidates), plan schema + version-checked applier with provenance and cleared-entry locking, reconciliation around apply, HTTP API (SSE chat, uploads, plans, reconciliation reads, health), Discord bot (threads, ✅/word approvals on the latest summary, attachments, catch-up, nudges), Gmail history walker with Nubank rules + Sonnet routing (gated), stale-account / pending-plan / Claude-health jobs, prompts, Dockerfile (Claude Code CLI inside), GHCR workflow, compose service, README.
- **Web app.** Advisor tab (conversation list, streaming chat, uploads, plan cards, plan review with inline edits and live balance check), pending-plans banner, budget health card replacing the piggy bank, "Plan with the advisor", cleared glyph + raw statement text on Ledger rows (confirm before editing a reconciled row), reconciled-through and suspense lines on Accounts cards, `VITE_APP_ADVISOR_URL`.
- **Docs.** `API_CONTRACT.md` (new RPCs/views), `advisor/README.md`, `CLAUDE.md` commands, `compose.yaml` banner, `LEDGER.md` follow-ups.

### Tests
`advisor/`: 63 tests (vitest) incl. the SQL suite run with `TEST_DATABASE_URL` against a throwaway database created from all 51 migrations (normalize_merchant fixtures, alias learning, the Tampopo classification case, reconciliation equation/continuity/locking, cleared glyph data). `app/`: 58 tests, `npm run build` clean, lint parity with `main`.

### Acceptance checks (dev database = copy of production taken 2026-10-14)
- Phase 0: `finances-advisor-dev` boots with web+discord; `GET /health` green (db, Claude login via the host's `~/.claude`, Discord connected, haiku health ping ok). A web conversation "Qual o saldo atual da conta Nubank…" was answered from `list_account_balances` in ~10 s (Opus session, logged in `advisor_claude_calls` with cost); Quick Entry suggestions keep working through the redefined RPC/view (`classify_candidates('Tampopo')` returns the household category first on the real history).
- Phase 1: the real Nubank OFX for September 2026 (37 lines, closing R$ 663,78) was uploaded through `POST /uploads`. The Opus session built one plan (21 `skip` for lines typed by hand in early September, 16 `create` incl. card-bill payments as transfers and caixinha movements, continuity check against the ledger opening balance, zero difference, four questions to the user on uncategorised items), recorded `statement_source` as a note and titled the conversation. `POST /plans/:id/approve {version:1}` applied 16 transactions with provenance (`metadata.source=advisor`, `statement_line.raw`), learned 9 merchant aliases, and the reconciliation closed `balanced` for 2026-09-01..30 (37 cleared, 0 outstanding, 0 missing); `account_balances.reconciled_through = 2026-09-30` and `ledger_balance_as_of(…, 2026-09-30) = 663.78 = LEDGERBAL`. Re-uploading the same file: 37/37 `already_in_ledger`, no new items. The continuity-break path is covered by the SQL suite (no real statement with a break was available). Fix found during the check: the statement account could not be resolved from the OFX alone (several Nubank accounts), so the account is now inferred from the plan's items at finalize/approve time and `statement_source` notes match on digits only.
- Phase 2: Discord bot connected; the stale-accounts nudge (24 accounts) posted once on first boot; the pending plan opened a thread with the summary, CSV and ✅ reaction, and the apply posted the balanced-reconciliation notice there. Approval by ✅/"aprova" is implemented and unit-tested; the real plan was approved from the web API.
- Phase 3: nudges, Claude health job, notes memory, conversation titles/summaries (the session set "Saldo Nubank" itself), budget plan items, suspense review in the prompt; §19 legacy cleanup: piggy bank removed, agent-first entries added, centro de custo needed no migration.

### Deployment (maintainer, non-normative)
Dev instance in the infra stack next to PostgREST dev, image built on the host from the branch, Claude login shared through a bind mount, public route with `flush_interval -1`, Cloudflare Pages preview of the branch with `VITE_APP_ADVISOR_URL` set for the preview environment. Gmail off until an OAuth client exists.

### Files
`migrations/0047…0051`, `advisor/**`, `app/src/components/advisor/**`, `app/src/components/BudgetHealthCard.tsx`, `app/src/lib/advisor-api.ts`, `app/src/lib/markdown.ts`, `app/src/lib/plan-utils.ts`, `app/src/App.tsx`, `Dashboard.tsx`, `BudgetPage.tsx`, `BudgetExecutionView.tsx`, `LedgerTable.tsx`, `AccountsPage.tsx`, `api.ts`, `Dockerfile`, `compose.yaml`, `compose.env.example`, `.env.example`, `.dockerignore`, `.github/workflows/advisor-image.yml`, `CLAUDE.md`, `docs/API_CONTRACT.md`, `LEDGER.md`.

## 2026-10-14 — AI Finances Advisor: investigation and implementation spec (docs/ADVISOR.md)

### Problem
Turn the ledger into an AI-assisted advisor/bookkeeper: ingest statements and receipts from Gmail and uploads, build editable insertion plans, reconcile balances with history, plan budgets by natural language, nudge on Discord. Runtime: one Docker service using the Claude Code CLI under the operator's subscription.

### Investigation
- Repo, migrations (at 0046), `mcp-server/` (21 tools) and `ADVISOR_PROMPT.md`.
- The maintainer's deployment (Postgres + three PostgREST containers behind a reverse proxy, app on Cloudflare Pages) and host resources; no Claude binary installed there.
- Data profile: ~9.7k transactions since 2022, `metadata` empty everywhere (no provenance/dedup), "Ajuste" is the 3rd most used description (booked to `sem-categoria`), `last_checked` goes stale for weeks, entry happens in bursts.
- Mailbox: Nubank emails account statements on request as OFX/PDF/CSV and card bills as CSV; no other bank emails statements.
- Sibling project (territorial-assistant): subscription-usage gating of background Claude work, single-shot `claude -p` with JSON schemas, closed action sets applied by code after ✅, runs on a Mac because of the keychain login. Pluggy/Open Finance was tried there and abandoned.

### Decisions (maintainer interview, options-based)
One Docker service with Claude Code OAuth only (no API fallback in v1) · plan-then-apply (Claude never writes to the ledger) · agentic resumable sessions with read-only tools · web app Advisor view first, Discord for notifications/approvals · ingestion: Gmail (Nubank), uploads, casual balance check-ins; no Pluggy · both household members, shared approvals · investigate gaps first, adjust only when told, every reconciliation recorded · nudges only on arrival or 30+ day staleness · code in `advisor/` in this repo · mirror user language · Opus for sessions, Sonnet for routine · Discord guild/bot/mailbox are operator env, nothing hard-coded (the app is open source) · legacy cleanup + agent-first budgeting (§19) · UI designed as a mockup for approval before implementation (§20).

### UI/UX approval
Designed the Advisor view as a clickable Design-canvas mockup (conversation with plan card, plan review table, dashboard hooks, empty/offline/waiting states, two mobile screens) before any code. Approved as designed by the maintainer the same day; the contract is `docs/ADVISOR.md` §20. The Dashboard piggy-bank indicator is replaced by a budget health card.

### Follow-up (same day) — classification, gate, reconciliation
Three adjustments from the maintainer folded into the spec:
- **Derived classification (§21, migration 0050).** `description_memories` was built for hand-typed short names and degraded once agents wrote raw statement text alongside household names (one merchant, two memories, wrong trigram matches). Replaced by `classify_candidates`, computed at query time over `transaction_lines` with factors name, raw statement text, amount, account, weekday/day-of-month/hour and recency, returning evidence and a margin-based confidence. The only stored, learned fact is `merchant_aliases` (raw text → household name). `match_description_memory` and `description_memories_with_names` are redefined over derived data so Quick Entry keeps working.
- **Gate.** Interactive messages are never gated or queued behind background work; the usage gate governs routine jobs only, and background work yields one slot to people.
- **Reconciliation as a core resource (§8, migration 0051).** `reconciliations` + `reconciliation_items` per account and statement period, with cleared/outstanding/missing/duplicate vocabulary, the equation `difference = statement_closing − (ledger_opening + Σ cleared)`, continuity between periods, locking of cleared entries, `ajustes` treated as a suspense account, and `reconciled_through` exposed on `account_balances`.

### Build-ready (same day)
Added §0 "Start here" to `docs/ADVISOR.md`: fixed implementation choices (Hono, pg, zod, discord.js, own OFX parser, pdftotext, pino, vitest incl. SQL tests against a throwaway Postgres, ghcr image), local dev loop, safety rails (prod/dev database guard), definition of done per phase. The two reconciliation UI touches (Ledger cleared glyph, Accounts reconciled-through + suspense) were added to the mockup as a seventh board so nothing is left "before implementing". `CLAUDE.md` now points at the spec.

### Files Created/Modified
- `docs/ADVISOR.md` (new): full implementation spec (architecture, migrations 0047–0051, Claude runner/gate/MCP tools, ingestion, reconciliation, approval/apply, web view, Discord, Gmail, self-hosting via compose, phases with acceptance checks, legacy cleanup, UI contract, maintainer appendix).
- `docs/README.md`: added ADVISOR.md to the index.
- `CLAUDE.md`: pointer to `docs/ADVISOR.md`.
- `LEDGER.md`: open items from the spec.
- `IMPLEMENTATION_LOG.md`

---

## 2026-09-02 — MCP Server for PostgREST API (mcp-server/)

### Problem
The user wants his wife (and himself) to be able to talk to the ledger through a chatbot (Claude, ChatGPT, etc.). Rather than building a new backend, PostgREST's existing public RPC/view surface (`docs/API_CONTRACT.md`) can be wrapped as MCP tools.

### Tasks
- [x] New standalone `mcp-server/` Cloudflare Worker package (TypeScript) exposing the finances PostgREST API as 21 MCP tools covering transactions CRUD, lookups, all read views, and the budget module.
- [x] Built on `createMcpHandler` (`agents/mcp/server`, MCP SDK v2) — **not** `McpAgent`. Verified directly against current Cloudflare docs that `McpAgent` (Durable-Object-backed) is deprecated and feature-frozen as of Agents SDK v0.20.0; `createMcpHandler` needs no Durable Object since every tool call here is an independent, stateless PostgREST proxy call.
- [x] Implemented raw-token → JWT exchange against `POST /rpc/login_with_token` (`src/auth.ts`), with an isolate-lifetime, sha256-keyed in-memory JWT cache and a single-retry-on-401 re-exchange, mirroring the frontend's reactive-only re-login pattern (`app/src/lib/api.ts`).
- [x] Implemented a small typed PostgREST client (`src/postgrest-client.ts`: `callRpc`/`getView` + `op.*` operator helpers matching `app/src/lib/api.ts`'s existing query-string conventions exactly), including PostgREST `{code, message, details, hint}` error mapping into MCP `isError: true` tool results.
- [x] `src/index.ts`'s `fetch` is the entire security boundary: a request to `/mcp` without a well-formed `Authorization: Bearer <token>` header is rejected with 401 before any MCP or PostgREST logic runs. Env and the raw token are threaded into the per-request `McpServer` factory via closure (env isn't part of `McpRequestContext`, and `requestInfo` on it isn't guaranteed present).
- [x] 20 unit tests (`vitest`) covering `auth.ts` (cache hit/miss/expiry, retry-once-no-loop), `postgrest-client.ts` (operator strings, URL building, error mapping), `register.ts` (exact 21-tool-name set), and `index.ts`'s 401 gate. Tool bodies themselves are intentionally untested (thin zod-validate → call → wrap, no branching).
- [x] Manually smoke-tested via `wrangler dev` against the live `https://api-finances-dev.marotta.dev` deployment: `initialize` handshake, `tools/list` (confirmed exactly 21 tools), and a `tools/call` with a deliberately invalid token (confirmed graceful `isError: true` — "Authentication failed: Invalid or revoked access token" — no crash).

### Decisions
- Chose the stateless `createMcpHandler` architecture over the initially-discussed `McpAgent`/Durable-Object approach, based on current Cloudflare guidance (verified directly, not just via research agent) — avoids a Durable Object whose only job would have been session-scoped JWT caching.
- Auth reuses the app's existing single-token mechanism verbatim: each household member gets their own raw token from `auth_tokens` (`scripts/generate_token.py`), passed as the MCP connection's bearer header. No OAuth, no Cloudflare Access, no shared static token — deliberately as simple as the frontend's own login.
- JWT caching is best-effort and isolate-scoped (a module-level `Map`), not backed by KV/DO — acceptable at 2-user personal-app volume; worst case is one extra `login_with_token` round-trip per tool call.
- Scope limited to exactly the RPC/view catalog in `docs/API_CONTRACT.md` (21 tools) — `app/src/lib/api.ts`'s additional endpoints (accounts/aliases CRUD, `global_settings`, `budget_plans` listing, `get_category_monthly_history`) are intentionally out of scope for v1.
- Tool results omit `structuredContent` (only `content: [{type:'text', ...}]` plus `isError`) — none of the 21 tools declare an `outputSchema`, so a hand-typed `structuredContent` shape isn't needed and would have fought the SDK's strict `CallToolResult` typing for no benefit.
- No secrets are held by the Worker — `POSTGREST_URL` is a plain (public) `vars` entry; the only credential in play is the caller-supplied raw bearer token, never persisted beyond the in-memory JWT cache.
- Deployment is via Cloudflare's Git integration (Workers Builds), not manual `wrangler deploy` from a terminal — matches the existing deploy pattern for other projects in the "Marotta e Territorial" Cloudflare account (confirmed via `territorial-maps`' build history). Root directory `mcp-server` in this repo.

### Follow-up (same day) — dev/production environment split
Split `wrangler.jsonc` into two named Wrangler environments instead of one implicit default, so the Worker can be deployed twice from the same codebase against the two existing PostgREST deployments:
- `env.production` → Worker `finances-mcp-production`, `POSTGREST_URL=https://api-finances.marotta.dev`.
- `env.dev` → Worker `finances-mcp-dev`, `POSTGREST_URL=https://api-finances-dev.marotta.dev`.

Both are named environments (no bare top-level deploy target) because Wrangler itself warns against deploying the implicit top-level config once multiple environments are defined — verified via `wrangler deploy --dry-run` (warns) vs `--env production`/`--env dev` (clean, correct `POSTGREST_URL` resolved for each). `vars` does not inherit between Wrangler environments, so each environment fully redeclares `POSTGREST_URL` rather than relying on a shared top-level value.

Each environment is its own Cloudflare "Workers & Pages" Git-connected project (same repo + root directory `mcp-server`), distinguished only by the dashboard's per-project **Deploy command** setting (`npx wrangler deploy --env production` vs `--env dev`).

### Files Modified (follow-up)
- `mcp-server/wrangler.jsonc`
- `mcp-server/README.md`

### Files Created/Modified
- `mcp-server/` (new package: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `.dev.vars.example`, `.gitignore`, `README.md`, `src/index.ts`, `src/server.ts`, `src/auth.ts`, `src/postgrest-client.ts`, `src/errors.ts`, `src/tool-result.ts`, `src/types.ts`, `src/tools/{transactions,lookups,views,budget,register}.ts`, corresponding `*.test.ts`)
- `docs/API_CONTRACT.md` — fixed stale `upsert_budget_item` arg table (was missing `p_sort_order`/`p_category_type`, added in migrations `0042`/`0044`)
- `IMPLEMENTATION_LOG.md`
- `LEDGER.md` (new)

---

## 2026-07-14 — Session-Scoped Quick Entry Defaults (Reset on Fresh URL)

### Problem
Quick Entry's default date/account was stored in `localStorage` (`quick_entry_last`), which is origin-wide and durable — it survived brand-new tabs and browser restarts, so a genuinely fresh visit silently reused whatever account/date was last used, even when the user wanted a clean slate. `selectedAccount` also had a second durable fallback to `global_settings.last_used_account_id` when `localStorage` was empty.

### Investigation
Audited every persistence mechanism used by the Ledger/Dashboard (`App.tsx`, `QuickEntryInput.tsx`, `LedgerFilterBar.tsx`, `Dashboard.tsx`). The Ledger filters + view (`App.tsx`'s `filters`/`view` state) are driven purely by URL query params with hard defaults when params are absent — this already resets correctly on a fresh, param-less URL while still hydrating from a shared URL and persisting across view switches via lifted React state. No bug there; left unchanged (confirmed with user to keep the existing year-to-date default range as-is).

### Tasks
- [x] **`QuickEntryInput.tsx`** — Swapped the `quick_entry_last` read/write sites (lazy `selectedDate` init, account-sync effect, both `executeTransaction` write sites) from `localStorage` to `sessionStorage`. `sessionStorage` is scoped to the tab's lifetime, which is exactly what's needed: it survives the component's unmount/remount when switching away from and back to the Ledger view (same session), but is empty on a genuinely new tab/session.
- [x] **`QuickEntryInput.tsx`** — Removed the `lastUsedAccount`/`lastUsedAccountId` fallback (derived from `global_settings.last_used_account_id`) entirely — deleted the now-dead memos. A fresh session no longer auto-selects an account.
- [x] **`QuickEntryInput.tsx`** — Main transaction text input now `disabled` until `selectedAccount` is set, with placeholder switching to "Select an account to begin...". No other gating needed — the Confirm button was already disabled whenever `preview` is null, and `preview` can never populate while the (disabled) input can't be typed into.
- [x] **`docs/PRODUCT.md`** — Rewrote the "Default account" section to describe the new session-scoped behavior instead of the old durable "last used account" default.

### Decisions
- `sessionStorage` over `localStorage` is the direct fix: it's the native browser primitive for "persist within this tab session, reset on a fresh one," which is precisely the desired behavior — no custom expiry/timestamp logic needed.
- Ledger filters/Dashboard date range persistence (`App.tsx`) needed no code change — its URL-param-driven mechanism already satisfied "same session persists, shared URL hydrates, fresh URL resets."

### Files Modified
- `app/src/components/QuickEntryInput.tsx`
- `docs/PRODUCT.md`
- `IMPLEMENTATION_LOG.md`

---

## 2026-07-06 — Advance Installment with Discount ("Adiantar Parcelas")

### Tasks
- [x] **`AdvanceInstallmentModal.tsx`** (new) — Modal for pulling a future installment forward: new date (defaults to today, capped at the installment's original date), fixed discount amount, income-category picker (required only when discount > 0), live before/after preview, reuses `updateTransaction`.
- [x] **`LedgerTable.tsx`** — Added a `UndoDot` icon button next to the amount on the collapsed row for any future, single-currency, 2-entry expense installment (`canAdvance` guard). Repointed the existing series-panel "Anticipate" link to open the same modal (via shared `advanceTarget` state) instead of mutating instantly. Removed the old no-discount `anticipateInstallment`/`anticipateMutation` path entirely — one confirmed, discount-aware flow replaces it.
- [x] **`docs/PRODUCT.md`** — Added "Installments" and "Adiantar Parcela" sections; the installment feature previously had zero documentation despite being shipped.

### Decisions
- Discount is booked as its own entry on an income-type account, not a reduction of the expense category entry — keeps the original expense/category/budget totals historically accurate; the discount shows up as separate income, matching how card issuers actually credit early-settlement discounts.
- Math: given original entries `categoryEntry (+A)` / `assetEntry (-A)` and discount `D` (`0 ≤ D < A`), new entries are `categoryEntry` unchanged, `assetEntry` amount shrunk toward zero by `D` (sign-aware), and a discount entry of the complementary sign on the chosen income account — sum stays 0 for any `D`. When `D = 0` the discount entry is omitted (identical to the old plain anticipate).
- No DB migration or new RPC needed — same as the feature it replaces, this is purely a frontend recomputation of entries passed to the existing `update_transaction` RPC.

### Fix (same day) — regression from over-strict button guard
- Initial version gated the button on `primaryType === 'expense' && entries.length === 2 && matching currency`, which was **stricter than the old "Anticipate" button** (which had no shape restrictions at all) — on real data this hid the button entirely for any installment that didn't fit that narrow shape, a regression.
- Fixed: button visibility now only requires the series-description regex match and a future date (parity with the old behavior). Discount math was generalized to only require a single asset/liability entry (any number of category entries pass through untouched); when a transaction doesn't have exactly one such entry, the modal still allows the plain date-only move but disables the discount input with an explanatory note instead of hiding the whole feature.

### Follow-up (same day) — sweep earlier pending installments
- `AdvanceInstallmentModal` now takes a `siblings` prop (fed from `LedgerTable.tsx`'s existing `allSeriesItems`). Any sibling with a lower installment number that's still dated after today is swept into the same action, moved to the same target date at full amount (no discount) — you can't anticipate a later installment while an earlier one is still pending. The discount only applies to the installment the modal was opened on. Confirm now issues one `updateTransaction` call per affected transaction via `Promise.all`, matching the concurrency pattern already used for installment creation in `QuickEntryInput.tsx`.
- The date field's upper bound is now `min(anchor's original date, all swept siblings' original dates)` rather than just the anchor's date, so a chosen date can never accidentally delay an earlier sibling instead of advancing it.

### Fix (same day) — floating-point balance error
- `update_transaction` rejected the recomputed entries with `SUM(amount_base) = 0.00000000000001` — the `update_transaction`/`create_transaction` RPCs check exact `NUMERIC` equality with no epsilon (`migrations/0015_update_transaction_rpc.sql`), and JS double subtraction (e.g. `-117.67 - (-14.57)`) doesn't land exactly on `-103.10`.
- Added a `round2()` helper in `AdvanceInstallmentModal.tsx` that snaps the recomputed asset and discount entries' `amount`/`amount_base` to cents before submission, eliminating the residual.

### Fix (same day) — real residual from uneven installment division, not just float noise
- The `round2()` fix wasn't enough: real installment amounts come from `amount / N` (e.g. `706/6 = 117.66666666666667`, per `QuickEntryInput.tsx`'s installment split), so the untouched category entry is genuinely *not* cent-precise — rounding only the asset/discount side left a real ~0.0017 mismatch, not just float dust.
- Replaced the float-based "solve for the last entry" math with **integer-cents arithmetic**: every entry touched by this feature (including previously-untouched category entries) is normalized to `Math.round(amount_base * 100)` cents, the new asset leg is solved for as `-(sum of all other entries in cents)`, then divided back by 100. Integer addition cancels exactly, and dividing an integer by 100 reliably round-trips to a clean 2-decimal JS number (verified numerically), so the decimal strings Postgres receives sum to exactly zero.
- This means advancing an installment with a discount now normalizes that transaction's amounts to 2-decimal precision going forward — an intentional, minor deviation from `docs/LEDGER_RULES.md`'s "keep full precision" guidance, scoped only to transactions this feature actually touches, since sub-cent precision from an uneven split isn't meaningful for a personal-finance ledger and can't be reconciled with an added discount without a big-decimal library.

### Redesign (same day) — discount as a separate income transaction
- Reworked per feedback: the discount is no longer a 3rd entry bolted onto the anticipated installment's own transaction. It's now a brand-new, standalone transaction created via `createTransaction` — description `Desconto - <installment description>` (referencing the anticipated one), dated the same as the new date, with exactly 2 entries: the chosen income category (negative) and the installment's own asset/liability account (positive, crediting the discount back).
- This makes the installment's own transaction untouched beyond its date (`updateTransaction` with its original `entries` unchanged) — the previous integer-cents balancing gymnastics are gone entirely, since a fresh 2-entry transaction is trivially balanced (`D + -D = 0`) with no dependency on the original entries' precision.
- `mutationFn` now batches up to 3 kinds of calls via `Promise.all`: the anchor's date-only update, each swept sibling's date-only update, and (if a discount was entered) the one new discount transaction.

### Files Modified
- `app/src/components/AdvanceInstallmentModal.tsx` (new)
- `app/src/components/LedgerTable.tsx`
- `docs/PRODUCT.md`
- `IMPLEMENTATION_LOG.md`

---

## 2026-05-27 — UX Fix: Calendar Icons Open Date Picker

### Tasks
- [x] **QuickEntryInput.tsx** — Added `dateInputRef` and wrapped Calendar icon in a `<button>` that calls `dateInputRef.current?.showPicker()` to open the native date picker on click.
- [x] **LedgerFilterBar.tsx** — Added `startDateRef`; Calendar icon now opens the start-date picker on click.
- [x] **ExportWizard.tsx** — Same pattern: `startDateRef` + Calendar icon button opens the start-date picker.

### Decisions
- Used `HTMLInputElement.showPicker()` — the standard programmatic API for opening the native date picker; no new dependencies needed.
- Calendar icon in Dashboard.tsx is already part of a functional button (custom range toggle) — no change needed there.
- LedgerTable.tsx and BudgetPlanWizard.tsx have date inputs without calendar icons — no change needed.

### Files Modified
- `app/src/components/QuickEntryInput.tsx`
- `app/src/components/LedgerFilterBar.tsx`
- `app/src/components/ExportWizard.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-05-27 — Dashboard: Expense Chart — Single Ring + Drill-Down

### Tasks
- [x] **Single ring**: Removed the multi-`<Pie>` concentric rendering (inner solid disc + outer donut). The chart now renders a single donut (`innerRadius=60, outerRadius=110`) regardless of data depth, matching the Income Sources chart style.
- [x] **Drill-down navigation**: `ExpenseBreakdownChart` now has local `drillPath: string[]` state. Starting at L1, clicking a category that has children drills into it (replaces the ring with its subcategories). Clicking again drills to L3. Clicking a leaf category toggles the global `categoryFilter` for the rest of the dashboard.
- [x] **Breadcrumb**: A breadcrumb row above the chart (visible when `drillPath.length > 0`) shows "All Expenses / Category / Subcategory" with each segment clickable to navigate back to that level.
- [x] **Reset on clear**: A `useEffect` resets `drillPath` when the external "Viewing: X | Clear" button nulls `categoryFilter`.
- [x] **Legend drill indicator**: Legend entries that have children show a "›" indicator; the legend header updates to show the current drill level name.
- [x] **Display names**: Fixed `formatPie` to use the last path segment as the display name (was stripping only the first segment, causing L3 names like `basica:mercado` instead of `mercado`).

### Decisions
- `drillPath` is local to `ExpenseBreakdownChart` — no need to lift it to Dashboard since `setCategoryFilter` is called on each drill to keep the rest of the dashboard in sync.
- Leaf-category click still toggles `categoryFilter` (not drill) so the existing "Viewing: X | Clear" affordance is preserved for leaf nodes.
- Single donut style chosen for visual consistency with the Income Sources chart.

### Files Modified
- `app/src/components/Dashboard.tsx`
- `IMPLEMENTATION_LOG.md`

---


## 2026-05-27 — Dashboard: Budget Highlights Panel + Section Reorder

### Tasks
- [x] **Dashboard section reorder** — New layout order: key indicators → budget highlights → asset breakdown history → expense+income dual panel → balance check-in. `BalanceCheckInPanel` moved from position 3 to end; asset history extracted from the 3-col grid into a standalone full-width `ChartCard`.
- [x] **Budget queries** — Added `fetchCurrentBudgetPlan`, `fetchBudgetItems`, `fetchBudgetMonthlySpending` queries to `Dashboard`. TanStack Query deduplicates them with Budget page queries.
- [x] **`budgetMetrics` useMemo** — Generates all plan months, filters to those within the dashboard date range, pro-rates targets (`period_amount / totalPlanMonths * monthsInRange`), sums spending per category, computes `overallPct`, `topItems` (top 7 by target), `totalTarget`, `totalSpent`. Returns `null` when no plan or no overlap.
- [x] **`BudgetHighlightsPanel`** — Glass panel (`ChartCard`-style). Left 2/3: scrollable list of category mini-bars (AccountIcon + leaf name + 1.5px progress bar + amounts). Right 1/3: `PiggyBankIndicator` + total spent/target summary.
- [x] **`PiggyBankIndicator`** — SVG piggy bank (viewBox 200×230). Body, ear, snout, 4 legs as `<clipPath>`. Two clipped rects (unfilled + filled) rise from bottom based on `pct`. Green (`#22C55E`) fill when ≤100%, red (`#EF4444`) when over. Pig outline, inner ear, eye, nostril dots, coin slot, leg outlines, tail drawn on top. `feDropShadow` filter on percentage text for legibility.

### Decisions
- Budget panel hidden entirely when `budgetMetrics` is null (no plan or date range outside plan) — no layout shift.
- Pro-ration uses simple `period_amount / totalPlanMonths * inRange.length` for all category types; good enough for dashboard overview without the BudgetExecutionView's rolling-adjustment complexity.
- `addMonths` from date-fns added to generate plan month grid.
- Unused type imports `BudgetPlan` and `BudgetMonthlySpending` omitted (TypeScript infers from query return types).

### Files Modified
- `app/src/components/Dashboard.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-05-27 — Budget Module: Category Insights Modal

### Tasks
- [x] **Migration 0046** — New RPC `get_category_monthly_history(p_account_id, p_months)`: generates last N calendar months, resolves account full name via `account_names_hierarchical`, sums `entries.amount_base` for the account and descendants using the same `LIKE full_name || ':%'` pattern, LEFT JOINs against month series so zero-spend months appear. Plan-independent (unlike `budget_monthly_spending`).
- [x] **api.ts** — Added `CategoryMonthlyHistory` interface and `fetchCategoryMonthlyHistory(accountId, months=13)` calling the new RPC.
- [x] **CategoryInsightsModal.tsx** — New modal component: fetches 13 months of history via `useQuery`, computes average/median/mode client-side, renders a Recharts `LineChart` with: actual spending line, average `ReferenceLine`, 3/6/12-month moving average lines (MA12 only when ≥12 months available). Apple-style dark modal (`bg-black/90 backdrop-blur-3xl rounded-3xl`). Stats shown as a 3-column grid. SVG legend row below chart. ESC + backdrop click close.
- [x] **BudgetCategoryRow.tsx** — Added `onInsights?: () => void` prop. Refactored outer `<button>` to `<div role>` to allow nested button. Replaced `w-8` spacer with insights button (amber Zap icon, opacity-0 → group-hover:opacity-100).
- [x] **BudgetExecutionView.tsx** — Added `insightsItem` state + `openInsights()` helper. Passed `onInsights` to all `BudgetCategoryRow` instances. Added `onInsights` prop + Zap button to `GroupOwnerHeader` and `GroupLabelHeader` (visible on group hover, alongside the existing chevron). Renders `CategoryInsightsModal` when `insightsItem` is set.
- [x] **BudgetPlanningView.tsx** — Added `insightsItem` state. Added `onInsights` prop to `PlanningRow` with a Zap button in the reorder/remove button group. Renders `CategoryInsightsModal` when `insightsItem` is set.

### Decisions
- Fetching 13 months (not 12) so the 12-month moving average is fully defined for the most recent display month; chart shows the last 12.
- Mode computed by bucketing amounts to nearest 100 (or 50 for small values) — meaningful for continuous financial data.
- `GroupLabelHeader` derives `account_id` from `childItems[0].parent_id`; name comes from `group.label`. Icon/color are null in this case (label-only groups have no account metadata readily available).
- Moving averages use partial windows at the start of the series (no null gaps).
- Build passes cleanly (tsc + vite).

### Files Modified
- `migrations/0046_category_monthly_history.sql` (new)
- `app/src/components/CategoryInsightsModal.tsx` (new)
- `app/src/lib/api.ts`
- `app/src/components/BudgetCategoryRow.tsx`
- `app/src/components/BudgetExecutionView.tsx`
- `app/src/components/BudgetPlanningView.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-05-26 — PR #5 Pre-Release Review: Budget Module Fixes

### Tasks
- [x] **Migration 0045** — Drops stale 5-param and 6-param overloads of `upsert_budget_item` left by migrations 0041 and 0042 (CREATE OR REPLACE with a different signature creates a new overload, not a replacement; 0044's 7-param version is the only one used).
- [x] **BUDGET_BACKLOG.md** — Marked all 4 phases as `[x]` (were completed but left unchecked).
- [x] **Hierarchical ledger drill-through** — `navigateToLedger` in `App.tsx` now accepts `accountFullName?`. If provided, it resolves all accounts whose `account_name` equals or starts with that prefix and passes them all as `accountIds`. This matches the aggregation logic in `budget_monthly_spending` (which rolls up sub-accounts via `LIKE full_name || ':%'`). `BudgetExecutionView.handleRowClick` now passes `item.account_full_name`. `BudgetPage` and `BudgetExecutionView` prop types updated accordingly.
- [x] **GroupLabelHeader aggregate thresholds** — Collapsed label-header now shows averaged `min_pct`/`max_pct` across all child items instead of using only the first child's values.
- [x] **helperText always visible** — Monthly adjustment text in `BudgetCategoryRow` changed from `opacity-0 hover:opacity-100` to `opacity-60 hover:opacity-100` so the notice is always readable (not hover-only).

### Decisions
- `accounts` query added to `AppContent` in `App.tsx` — TanStack Query deduplicates it against the same query already used in `BudgetPlanningView`, `QuickEntryInput`, etc., so no extra network call.
- `navigateToLedger` deps updated to include `accounts`; `useCallback` recreates the callback on accounts refresh (negligible cost).
- Averaged thresholds for grouped bar are display-only; no financial impact.

### Files Modified
- `migrations/0045_budget_function_cleanup.sql` (new)
- `BUDGET_BACKLOG.md`
- `app/src/App.tsx`
- `app/src/components/BudgetPage.tsx`
- `app/src/components/BudgetExecutionView.tsx`
- `app/src/components/BudgetCategoryRow.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-05-26 — Budget: Monthly vs Yearly Category Types

### Tasks
- [x] **Migration 0044** — Added `category_type TEXT DEFAULT 'yearly'` to `budget_items` with CHECK constraint (`monthly` | `yearly`). Rebuilt `budget_items_with_accounts` view and updated `upsert_budget_item` RPC to accept `p_category_type`.
- [x] **api.ts** — Added `category_type` to `BudgetItemWithAccount` interface; added `categoryType` parameter to `upsertBudgetItem`.
- [x] **BudgetPlanningView.tsx** — Added `category_type` to `DraftItem`; per-row type toggle pill (blue = Monthly, amber = Yearly); separate section headers with explanatory captions; reorder buttons constrained within same type; `handleSave` passes `category_type` to upsert.
- [x] **BudgetExecutionView.tsx** — Two-section layout (Monthly on top, Yearly on bottom) with colored section headers; monthly vertical adjustment algorithm (`computeMonthlyVerticalAdjustments`); monthly aggregate BudgetBar header showing total monthly budget vs total spent; `resolveItemValues` branches on `category_type`.

### Decisions
- **Yearly**: unchanged horizontal rolling adjustment (`computeAdjustedMonthly` — remaining period budget / remaining months).
- **Monthly**: fixed base monthly (period_amount / numMonths) with no carryover. Within a given month, overspenders' excess is redistributed proportionally from underspenders' surplus. The adjustment is display-only (nothing written to DB); next month resets to base.
- Vertical adjustment formula: `coverable = min(totalOverspend, totalUnderspendSurplus)`. Overspenders get `target = spent` (shows 100%). Underspenders get `target = base - (coverable × base / totalUnderspendBudget)`, floored at `spent`.
- In period view: monthly items show `period_amount` as target with total spending (no rolling adjustment).
- Monthly section aggregate bar uses `minPct=0, maxPct=200` so no threshold markers appear in normal range.
- `buildGroups` called separately per type so collapsible hierarchy works within each section independently.
- Existing items default to `'yearly'` via the DB DEFAULT — no data migration needed.

### Files Modified
- `migrations/0044_budget_category_type.sql` (new)
- `app/src/lib/api.ts`
- `app/src/components/BudgetPlanningView.tsx`
- `app/src/components/BudgetExecutionView.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-05-26 — Budget Execution View: Phase 2 Improvements

### Tasks
- [x] **Plan title**: `plan.name` + date range rendered above the category table in `BudgetExecutionView`
- [x] **Unified group model**: `buildGroups()` replaces `buildRenderNodes`. Every item belongs to a group. Group header is the parent's interactive budget row when parent is in budget; label-only row otherwise. Orphan items get a label header + their row below (name repeats as designed).
- [x] **Collapsible groups**: `collapsed: Set<string>` state. Each group header has a chevron toggle. `GroupOwnerHeader` and `GroupLabelHeader` sub-components handle the two header variants.
- [x] **Aggregation when collapsed**: `aggregateGroup()` sums spent/target/remaining across all items in the group. Shown in the header row when collapsed.
- [x] **Sort order (DB)**: Migration `0042_budget_sort_order.sql` — adds `sort_order INTEGER DEFAULT 0` to `budget_items`, updates view and `upsert_budget_item` RPC. `BudgetItemWithAccount` and `upsertBudgetItem` updated in `api.ts`.
- [x] **Sort order (UI)**: `DraftItem` gains `sort_order`. ↑/↓ buttons on each `PlanningRow` swap adjacent sort orders. `handleSave` passes `sort_order` to upsert. Planning list sorted by `sort_order`.
- [x] **"Outros" row**: Migration `0043_budget_period_totals.sql` — `budget_period_totals` view aggregates total expense spending per month per plan. `fetchBudgetPeriodTotals` added to `api.ts`. Execution view computes `othersSpent = totalAllSpent - totalBudgetedSpent` and renders an "Outros" row when > 0.

### Decisions
- Groups keyed by `parent_id` (for label-only groups) or `account_id` (for owner groups / orphans) — stable across re-renders.
- `buildGroups` sorts groups by `minSortOrder` (minimum sort_order among group items) so group order tracks the user's intent from the planning view.
- "Outros" uses no `BudgetBar` (no target) — just a spent label; shown only when unbudgeted spending > 0.
- DB migrations are `CREATE OR REPLACE` / `ADD COLUMN IF NOT EXISTS` — safe to re-run.
- Migrations still need to be applied via `python scripts/migrate.py`.

### Files Modified
- `migrations/0042_budget_sort_order.sql` (new)
- `migrations/0043_budget_period_totals.sql` (new)
- `app/src/lib/api.ts`
- `app/src/components/BudgetExecutionView.tsx`
- `app/src/components/BudgetCategoryRow.tsx`
- `app/src/components/BudgetPlanningView.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-05-25 — Budget Module: Bug Fix Session

### Tasks
- [x] **Bug 1 — Remaining ignores current month**: Removed `getPeriodRemaining`. Compute `remaining` inline alongside `spent`/`target`; in monthly mode `remaining = target - spentThisMonth`, in period mode `remaining = period_amount - spentTotal`.
- [x] **Bug 2 — Add-category dropdown clipped**: Split category table container into `rounded-t-xl overflow-hidden` (table + rows) and a separate `rounded-b-xl` div (SearchableSelect only). The add row has no `overflow-hidden`, allowing the dropdown to render freely.
- [x] **Bug 3 — Category name missing parent**: Both `BudgetCategoryRow` and `PlanningRow` now derive `parentName` from `account_full_name` (split on `:`). At depth 0 (execution) or always (planning), shows `parentName › leafName`. At depth > 0 the parent row is already visible above, so only the leaf is shown.
- [x] **Bug 4 — Siblings not grouped**: Root-level items are stable-sorted by `parent_id` before `buildHierarchy` so siblings are always adjacent. `buildRenderNodes` emits a `group-header` node when a new parent group begins (parent not in budget).
- [x] **Bug 5 — Parent categories not styled as containers**: `isParent` flag computed per item (`items.some(other => other.parent_id === item.account_id)`). `BudgetCategoryRow` accepts `isParent?` — parent rows get `bg-white/[0.03]` background and `font-semibold` name.

### Decisions
- `buildRenderNodes` replaces the old `buildHierarchy` + inline `getDepth` pattern; returns a discriminated-union array (`item | group-header`) for clean render logic.
- `remaining` was always period-level before; now it tracks the selected view (monthly remaining = how much is left of this month's target, not the full plan).
- Removed the `formatHierarchicalName` import from `BudgetCategoryRow` — name formatting is now inline and context-aware (depth-based).

### Files Modified
- `app/src/components/BudgetExecutionView.tsx`
- `app/src/components/BudgetCategoryRow.tsx`
- `app/src/components/BudgetPlanningView.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-05-25 — Budget Module: Phase 4 — Planning View

### Tasks
- [x] `api.ts` — added `fetchAllBudgetPlans`, `createBudgetPlan`, `setCurrentBudgetPlan`, `upsertBudgetItem`, `deleteBudgetItem`
- [x] `BudgetPlanWizard.tsx` — name + period modal → `create_budget_plan` RPC; defaults to current year; Escape/backdrop dismiss; Confirm disabled until valid
- [x] `BudgetPlanListModal.tsx` — lists all plans ordered by `created_at desc`; Set current button (disabled with checkmark when already current); "New Plan" entry point
- [x] `BudgetPlanningView.tsx` — editable category rows with AccountIcon, amount input (Monthly↔Yearly toggle), Min%/Max% inputs, live BudgetBar preview, remove button; add-category SearchableSelect (expense accounts only, not already in plan); Save commits all upserts + deletes in parallel; dirty tracking via `setDirty` callback
- [x] `BudgetExecutionView.tsx` — added `onCreatePlan?` prop; empty state shows "Create Budget Plan" button
- [x] `BudgetPage.tsx` — wired Plans button → `BudgetPlanListModal`; wired wizard open/close; replaced planning stub with `BudgetPlanningView`; dirty-state guard on mode switch via `isDirtyRef`; hoisted `useQuery(['budgetCurrentPlan'])` to pass `plan` to planning view

### Decisions
- `isDirtyRef` (not state) in `BudgetPage` avoids re-renders when dirty flag changes; only consulted on mode-switch click.
- `BudgetPlanningView` resets draft via `useEffect` on `serverItems` — covers plan switches without needing an explicit reset callback.
- Amount input stores `period_amount` (total for period); Monthly/Yearly toggle is pure display state per row; switching recalculates the displayed value without losing precision.
- Save uses `Promise.all` for upserts + deletes (not sequential) — order doesn't matter since each item is identified by `(plan_id, account_id)`.
- `fetchAllBudgetPlans` uses `?order=created_at.desc` so the list modal always shows newest plans first.
- `BudgetPlanWizard` invalidates both `['budgetCurrentPlan']` and `['budgetPlans']` on success so both the execution view and list modal update instantly.
- TanStack Query deduplicates the `['budgetCurrentPlan']` fetch between `BudgetPage` and `BudgetExecutionView` — no extra network call.

### Files Modified
- `app/src/lib/api.ts`
- `app/src/components/BudgetPlanWizard.tsx` (new)
- `app/src/components/BudgetPlanListModal.tsx` (new)
- `app/src/components/BudgetPlanningView.tsx` (new)
- `app/src/components/BudgetExecutionView.tsx`
- `app/src/components/BudgetPage.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-05-25 — Budget Module: Phase 3 — Execution View

### Tasks
- [x] `BudgetBar.tsx` — bar with 3 states (under target / over target within max / over max), threshold markers (min, target, max), helper values row (Min / Target / Max / Remaining)
- [x] `BudgetCategoryRow.tsx` — category name + AccountIcon + BudgetBar + spent amount; click navigates to Ledger
- [x] `BudgetExecutionView.tsx` — fetches current plan, budget items, and monthly spending; renders hierarchical rows with rolling-adjustment targets; empty state when no plan
- [x] "← Back to Budget" button in LedgerTable toolbar (shown only when navigated from Budget)
- [x] `api.ts` — added `BudgetPlan`, `BudgetItemWithAccount`, `BudgetMonthlySpending` interfaces and `fetchCurrentBudgetPlan`, `fetchBudgetItems`, `fetchBudgetMonthlySpending` functions
- [x] `BudgetPage.tsx` — accepts `onNavigateToLedger` prop; wires `BudgetExecutionView` in execution mode
- [x] `App.tsx` — `fromBudget` state + `navigateToLedger` callback thread through to `BudgetPage` and `LedgerTable`

### Decisions
- `BudgetBar` receives pre-computed `target` (adjustedMonthly or period_amount) so it stays generic and reusable for both Monthly and Period views.
- Rolling adjustment (`computeAdjustedMonthly`) lives inline in `BudgetExecutionView`; no separate module needed yet.
- Hierarchy rendering uses `buildHierarchy` recursive helper operating on the flat `budget_items_with_accounts` list — no tree pre-build needed.
- `fromBudget` boolean in `App.tsx` controls the back-button visibility; resets on any manual nav click.
- `navigateToLedger` sets both `accountIds` filter and the month date range from the current navigation month.

### Files Modified
- `app/src/lib/api.ts`
- `app/src/components/BudgetBar.tsx` (new)
- `app/src/components/BudgetCategoryRow.tsx` (new)
- `app/src/components/BudgetExecutionView.tsx` (new)
- `app/src/components/BudgetPage.tsx`
- `app/src/components/LedgerTable.tsx`
- `app/src/App.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-05-25 — Budget Module: Phase 2 — Budget Page Shell

### Tasks
- [x] Added `budget` to the view type union in `App.tsx`; added "Budget" tab (PiggyBank icon) to top nav
- [x] Created `BudgetPage.tsx` — sub-mode switcher (Execution | Planning), month navigator (`← May 2026 →`), period toggle (Monthly | Period), Plans button stub

### Decisions
- All four controls in `BudgetPage` use local React state; no global state needed at this shell stage.
- Month navigator uses `addMonths`/`subMonths`/`startOfMonth` from date-fns (already installed).
- Execution and Planning content areas are inline stubs — deleted in Phase 3/4 when real views land.
- Plans button is a visual stub only; wired to `BudgetPlanListModal` in Phase 4.
- `PiggyBank` chosen as the Budget nav icon for clear semantic fit.

### Files Modified
- `app/src/App.tsx`
- `app/src/components/BudgetPage.tsx` (new)
- `IMPLEMENTATION_LOG.md`

---

## 2026-05-25 — Budget Module: Phase 1 — Database

### Tasks
- [x] `migrations/0039_budget_plans.sql` — `budget_plans` and `budget_items` tables
- [x] `migrations/0040_budget_views.sql` — `budget_items_with_accounts` and `budget_monthly_spending` views
- [x] `migrations/0041_budget_rpcs.sql` — `create_budget_plan`, `set_current_budget_plan`, `upsert_budget_item`, `delete_budget_item` RPCs

### Decisions
- `budget_items` has `ON DELETE CASCADE` from `plan_id` so deleting a plan removes its items atomically.
- No DB-level CHECK for `account_id` type — enforced in `upsert_budget_item` RPC (spec-specified; requires a join).
- `budget_monthly_spending` uses the same `full_name LIKE '…:%'` hierarchy rollup pattern as `account_balances` rather than a recursive CTE; pre-aggregates monthly spending in a CTE then LEFT JOINs against a `plan_months` grid so all months within the plan period appear even with zero spending.
- `create_budget_plan` sets all existing plans to `is_current = FALSE` before inserting the new plan as current — matches `set_current_budget_plan` logic.
- All RPCs use `SECURITY DEFINER` and have explicit `GRANT EXECUTE TO authenticated` (default privileges from 0021 would cover it, but spec requires explicit grants).

### Files Created
- `migrations/0039_budget_plans.sql`
- `migrations/0040_budget_views.sql`
- `migrations/0041_budget_rpcs.sql`

---

## 2026-05-25 - Budget Module: Feature Specification and Documentation

### Tasks
- [x] Wrote `docs/BUDGET_MODULE.md` — full feature spec for the budget/planning module
- [x] Updated `docs/DOMAINS.md` — added `budget_plans` and `budget_items` entity descriptions
- [x] Updated `docs/API_CONTRACT.md` — added 4 RPC specs and 2 view specs for the budget module
- [x] Updated `docs/ARCHITECTURE.md` — removed "budgeting" from the "NOT included" list

### Scope
The budget module adds a 4th top-level tab (Budget) with Execution/Planning sub-modes. Users define budgets per expense category with a period total amount and monthly min/max % thresholds. A rolling adjustment algorithm redistributes the remaining budget across future months based on past spending. Clicking a category bar navigates to the Ledger with pre-applied filters.

### Decisions
- `period_amount` stored as the single source of truth; all monthly targets are derived.
- Rolling adjustment is computed frontend-side from the `budget_monthly_spending` view; no stored intermediates.
- `budget_monthly_spending` uses a recursive CTE to roll up spending from descendant accounts, matching the existing `account_balances` pattern.
- Budget items are always in base currency — no multi-currency budget targets.
- The module is read-only from an accounting perspective (never writes transactions).

### Files Modified
- `docs/BUDGET_MODULE.md` (new)
- `docs/DOMAINS.md`
- `docs/API_CONTRACT.md`
- `docs/ARCHITECTURE.md`
- `IMPLEMENTATION_LOG.md`

---

## 2026-05-24 - Financial Analysis: Spending Patterns 2022–2026

- Connected to live database and ran spending/income analysis across all years.
- Identified key income drivers (Territorial business growth), major expense jumps (new apartment in Sudoeste, HRV financing, personal spending), and savings opportunities.
- No code changes — pure data analysis session.

---

## 2026-04-29 - Quick Entry Done/Confirm button validity state

- Updated `QuickEntryInput` submit button visual logic to match its actual enabled/disabled behavior.
- Added `isSubmitEnabled` boolean and reused it for both `disabled` and class styling, so the button only appears active when clickable.
- Active `Confirm`/`Done` state now uses a green (`emerald`) style to clearly indicate valid input and readiness to submit.
- Files: `app/src/components/QuickEntryInput.tsx`, `IMPLEMENTATION_LOG.md`

## 2026-04-17 - Docker Compose (Postgres, PostgREST, nginx SPA)

- Root `Dockerfile` (Node build → Python + nginx): runs `migrate.py` and `set_jwt_secret.py` on container start, then serves Vite `dist`.
- `compose.yaml`: `db`, `app` (build), `postgrest`; PostgREST waits on app health so migrations finish before the API starts; CORS via `APP_ORIGIN`.
- Supporting: `docker/entrypoint.sh`, `docker/nginx.conf`, `.dockerignore`.
- Optional `FINANCES_BOOTSTRAP_TOKEN`: `ensure_bootstrap_token.py` in entrypoint registers that plaintext token idempotently after migrations.
- `compose.yaml` banner documents all compose-time env vars with local defaults; `compose.env.example` is an optional `.env` template for overrides.
- Docker UI build uses `COMPOSE_VITE_APP_API_URL` (not `VITE_APP_API_URL`) so repo `.env` for `npm run dev` does not override the baked API URL.

## 2026-04-17 - Balance check-in UI: asset/liability filter, icons, multi-column grid

- Stale list now includes any **non-hidden `asset` or `liability`** account (removed subtype-only filter).
- Rows use **`AccountIcon`** + ledger-style **name** (`text-primary/80`) and **account type** subtitle.
- **Responsive `auto-fill` grid** (`minmax(12.5rem→13.5rem, 1fr)`) for dense columns; compact bordered cells.
- Files: `app/src/components/Dashboard.tsx`, `IMPLEMENTATION_LOG.md`

---

## 2026-04-17 - Dashboard balance check-in (stale account checklist)

### Feature
- **`last_checked` on `accounts`**: nullable `TIMESTAMPTZ`, exposed on `account_balances` for the dashboard.
- **Balance check-in panel** on [`Dashboard.tsx`](app/src/components/Dashboard.tsx): lists bucket accounts (`checking`, `emergency`, `investments`, `liabilities`) that are **stale** — `last_checked` is null (“Never checked”) or older than 7 days — **excluding hidden** accounts. Placed **after** net worth, **before** main charts.
- **Checkbox** per row calls `markAccountChecked` → `PATCH /accounts` with ISO timestamp; invalidates `['accounts']` on success.
- **Helper** [`isBalanceCheckStale`](app/src/lib/balanceCheckStale.ts) + Vitest coverage.

### Incidental
- [`parser.ts`](app/src/lib/ledger-parser/parser.ts): transfer branch now guards `amount == null` before `isNaN(amount)` so `tsc` accepts `number | null` from `parseLocalizedAmountToken`.

### Files
- `migrations/0038_account_last_checked.sql`
- `app/src/lib/api.ts` — `Account` / `AccountNode.last_checked`, `fetchAccounts` defaults, `markAccountChecked`, `updateAccount` pick
- `app/src/lib/balanceCheckStale.ts`, `app/src/lib/balanceCheckStale.test.ts`
- `app/src/components/Dashboard.tsx`
- `app/src/lib/ledger-parser/parser.ts`
- `IMPLEMENTATION_LOG.md`

---

## 2026-04-17 - Localized Amount Parsing: Thousand Separators + Last Decimal Separator

### Problem
Quick entry parsing treated `.` and `,` as interchangeable decimal separators with a simple replacement strategy. Inputs like `1.250,86` were interpreted incorrectly, causing cents after the comma to be ignored in some paths.

### Fix
- Added `parseLocalizedAmountToken()` in `app/src/lib/ledger-parser/parser.ts`.
- New parsing rule: for numeric tokens containing separators, the **last** `.` or `,` is treated as the decimal separator, and all earlier separators are treated as grouping (thousand) separators.
- Wired this helper into all amount extraction paths:
  - transfer parsing (`from > to amount [CURRENCY]`)
  - regular amount token detection
  - installment shorthand (`amountxN`)

### Tests
- Added parser tests covering:
  - `padaria 1.250,86` -> `1250.86`
  - `padaria 1,250.86` -> `1250.86`
  - `wise > nubank 1.250,86` -> transfer amount `1250.86`
  - `compra 1.250,86x12` -> `1250.86` with installments
- Full parser suite now passes (`44` tests).

### Files Modified
- `app/src/lib/ledger-parser/parser.ts`
- `app/src/lib/ledger-parser/parser.test.ts`
- `IMPLEMENTATION_LOG.md`

---

## 2026-04-17 - Auto-detect Income from Matched Category + Expense/Income Toggle UI

### Problem
1. **Bug**: When `QuickEntryInput` matched a description memory whose category was type `income` (e.g. `recebimentos`), the preview always defaulted to expense direction. The `category_type` field from `matchDescriptionMemory` was fetched but never used to flip entry signs.
2. **UI inconsistency**: Switching between expense and income was exposed as raw sign math in two different ways — "TOGGLE SIGN" text button in QuickEntryInput and a per-entry `+/-` sign button in LedgerTable edit mode.

### Fix
- **QuickEntryInput `updatePreview`**: After resolving `finalCategory` and `bestMatch`, derive `detectedCategoryType` from `bestMatch.category_type` (or by checking if category name starts with `income:`). If income, build entries with negated signs from the start (category negative, asset positive).
- **QuickEntryInput UI**: Replaced "TOGGLE SIGN" text button with a compact "Expense / Income" segmented pill. Active option highlighted in its respective color (red/green). Clicking the inactive option calls `toggleAllSigns()` unchanged.
- **LedgerTable `TransactionRow`**: Replaced the `toggleSign(index)` per-entry function with `toggleAllSigns()` which inverts all entries at once. Removed the `+/-` sign buttons from entry rows. Added a single "Expense / Income" segmented pill to the edit header (hidden for transfers), derived from `editType`.

### Files Modified
- `app/src/components/QuickEntryInput.tsx`
- `app/src/components/LedgerTable.tsx`
- `IMPLEMENTATION_LOG.md`

---

## 2026-04-16 - Fix Territorial Account Classifications

### Problem
In `finances-territorial`, two accounts were miscategorized:
- `nu-caixinha` was type `equity` with no subtype — dashboard balance cards and asset history graph only track accounts with subtypes `checking`/`emergency`/`investments`/`liabilities`, so it was invisible
- `nu-conta` was type `asset` with no subtype — same issue

Result: Checking/Emergency/Investments all showed R$0.00 even though R$5,000 sat in `nu-caixinha`.

### Fix
Migration `0037_fix_territorial_account_types.sql`:
- `nu-caixinha`: type `equity` → `asset`, subtype → `checking`
- `nu-conta`: subtype → `checking`

Migration is name-based and safe to run on both databases (0 rows affected where accounts don't exist).

### Files Created/Modified
- `migrations/0037_fix_territorial_account_types.sql` (new)
- `IMPLEMENTATION_LOG.md`

---

## 2026-04-16 - Fix Expense Breakdown Chart for Shallow Account Hierarchies

### Problem
The "Expense Breakdown" pie chart was empty or partially empty when expense accounts had fewer than the expected depth levels. The code assumed account names had an `expenses:` root prefix (e.g., `expenses:food:grocery`), requiring `parts.length >= 2` before adding to L1. But `account_names_hierarchical` returns names without the type prefix (e.g., just `alimentacao` or `alimentacao:basica`), so single-segment names never appeared in any ring, and two-segment names appeared only in L1.

This caused `finances-territorial` (all depth-1 expense accounts) to show a completely empty chart, and `finances` (depth 1–2) to show only the L1 ring.

### Fix
- **Level logic**: Corrected to treat depth-1 as L1, depth-2 as L2, depth-3 as L3. Single-segment names now always appear in L1.
- **Income**: Same fix applied — was using `parts.slice(0,2).join(':')` (requiring depth 2), now uses `parts[0]`.
- **Adaptive rings**: Extracted `ExpenseBreakdownChart` component that detects how many levels have data and renders 1, 2, or 3 rings accordingly, with adjusted radii so single-level data fills the chart nicely.
- **Legend**: Moved into the new component; still shows L1 top categories.

### Files Modified
- `app/src/components/Dashboard.tsx`
- `IMPLEMENTATION_LOG.md`

## 2026-04-15 - Account Mismatch Warning in QuickEntryInput

### Tasks
- [x] **App.tsx** — Pass `filters` prop to `<QuickEntryInput />` so it can see the active ledger account filter.
- [x] **QuickEntryInput** — Added `filters?: LedgerFilters` prop; import `type LedgerFilters` from `LedgerFilterBar`.
- [x] **Mismatch detection** — `isMismatch` is true when `filters.accountIds` is non-empty and `selectedAccount`'s ID is not in that list. Tracked via a stable key `${selectedAccountId}|${sortedFilterIds}`.
- [x] **One-time confirmation** — `confirmTransaction` gates on `isMismatch && !isAcknowledged`; shows an inline amber confirmation panel in the preview footer instead of submitting. "Proceed anyway" records the acknowledged key and calls `executeTransaction()` directly.
- [x] **Persistent banner** — After acknowledgement, an amber strip above the input reads "Entering into [account] — not shown in current filter".
- [x] **Auto-reset** — A `useEffect` on `currentMismatchKey` hides the confirm panel whenever the filter or selected account changes, causing the dialog to reappear on the next submit attempt.

### Decisions
- Split `confirmTransaction` into `executeTransaction` (raw submission) + `confirmTransaction` (mismatch gate) + `handleMismatchConfirm` (acknowledge + execute) to avoid async state race conditions.
- Used a string key rather than separate boolean flags so acknowledgement is automatically scoped to the exact (account × filter-set) combination.
- Banner and dialog are purely frontend — no migrations or API changes needed.

### Files Modified
- `app/src/App.tsx`
- `app/src/components/QuickEntryInput.tsx`

---

## 2026-04-08 - Multi-Currency Handling Improvements

### Tasks
- [x] **Migration 0036** — Seeded `base_currency = 'BRL'` in `global_settings`.
- [x] **API** — Added `fetchExchangeRate(date, fromCurrency, baseCurrency)` in `app/src/lib/api.ts`. Calls Frankfurter API (`https://api.frankfurter.dev/v2/rates`) with `base={fromCurrency}&quotes={baseCurrency}` and returns the rate (e.g., 5.72 for USD→BRL).
- [x] **QuickEntryInput** — Added `baseCurrency` derived from `global_settings`. Made `buildTx` async: when `parsedCurrency !== baseCurrency`, fetches the real exchange rate from Frankfurter and stores `exchange_rate` and correct `amount_base = amount * rate`. Fixed `currency` on entries to use the parsed currency from input (not hardcoded `lastUsedCurrency`). Fixed preview amount prefix from hardcoded `$` to actual currency code from parsed input.
- [x] **LedgerTable** — Fixed display bug: main row `amount` was computed from `amount_base` (BRL) but formatted with `entry.currency` (e.g., USD), showing wrong currency symbol. Now `currency` in `TransactionItem` is always `'BRL'` since `amount` is always derived from `amount_base`. Entry detail view now shows both original (e.g., `470 USD`) and base equivalent (`≈ R$2,688`) when currencies differ.

### Decisions
- Exchange rate is fetched at submit time (not at preview time) to avoid redundant API calls while the user is still typing.
- The Frankfurter API response for v2 is `[{ date, base, quote, rate }]` (array), not the v1 `{ rates: { BRL: ... } }` object — parsing adjusted accordingly.
- The Frankfurter API is called with `base={foreignCurrency}&quotes={baseCurrency}` to get the direct exchange rate without needing inversion.
- `amount_base` always stores the value in base currency; `amount` stores the value in the original currency. Both are now correctly stored for multi-currency entries.
- Base currency is `'BRL'` by default, stored in `global_settings` and can be changed via DB if needed.

### Files Modified
- `migrations/0036_base_currency.sql` (new)
- `app/src/lib/api.ts`
- `app/src/components/QuickEntryInput.tsx`
- `app/src/components/LedgerTable.tsx`

---

## 2026-04-08 - Multi-Currency UX: Live Rate Preview + Case-Insensitive Currency

### Tasks
- [x] **Parser** — Currency detection is now case-insensitive (`usd`, `USD`, `UsD` all work). Both expense and transfer patterns updated; detected currency is always normalized to uppercase.
- [x] **QuickEntryInput: live rate fetch** — Exchange rate is now fetched during `updatePreview` (not just at submit). New state: `parsedCurrency`, `exchangeRate`, `isFetchingRate`. A `cancelled` flag prevents stale state updates when input changes rapidly.
- [x] **QuickEntryInput: preview display** — Amount box shows `≈ R$X.XX` (converted value) below the input while typing; shows `converting…` while the rate is in flight. A `1 USD = 5.1359 BRL` info line appears below the entries whenever the parsed currency differs from base.
- [x] **QuickEntryInput: buildTx** — Now synchronous again; uses cached `exchangeRate` from state, falling back to a fresh fetch only if state is null (edge case).

### Decisions
- Rate is fetched in `updatePreview` (debounced 50ms) rather than on every keystroke. This keeps the UX responsive while minimizing API calls.
- `parsedCurrency` is stored in state so both the preview UI and `buildTx` share the same resolved value without re-parsing the input.

### Files Modified
- `app/src/lib/ledger-parser/parser.ts`
- `app/src/components/QuickEntryInput.tsx`

---

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
