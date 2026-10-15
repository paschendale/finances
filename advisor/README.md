# finances-advisor

The AI advisor, bookkeeper and assistant for the finances ledger. One Node 22 daemon that:

- runs **Claude Code** sessions (your own subscription login, no API key) with read-only ledger tools
  and plan-drafting tools over a local MCP server;
- ingests bank statements (OFX, CSV, PDF, images) from uploads, Discord attachments and a Gmail
  mailbox into reviewable **insertion plans**; a person approves, the daemon applies through the
  existing PostgREST RPCs with provenance. Uploads take any file: something that is not a parsed
  statement (a purchase list, an invoice, a spreadsheet) is stored as is and the session reads it and
  checks it against the ledger;
- keeps **reconciliations** per account and statement period (cleared / outstanding / missing /
  difference) and never books an adjustment without being told;
- serves the web app's Advisor view (chat with streaming, plan review) and, optionally, a Discord
  channel (threads, ✅ approvals, nudges for stale accounts).

Design and decisions: [`docs/ADVISOR.md`](../docs/ADVISOR.md).

## Run it

Requirements: the finances database with migrations ≥ `0051` applied, a PostgREST instance for it,
and a finances token for the daemon (`python scripts/generate_token.py "advisor"`).

```bash
# local, from the repo root
docker compose up --build            # db + postgrest + app + advisor
docker compose exec -it advisor claude login   # one-time: opens a URL, finish it on any device
curl -s localhost:3100/health | jq .claude.loggedIn   # → true
```

Then open the app, Advisor tab, say "oi". Upload a statement (paperclip or drag-and-drop); a plan
appears in the conversation; review, edit, approve.

Without Docker:

```bash
cd advisor
cp ../.env.example .env   # or export the variables below
npm install
npm run dev               # tsx watch, ADVISOR_CHANNELS=web by default
```

`claude` must be on `PATH` (or `CLAUDE_BIN`), logged in (`claude login`) on the same user.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection for `advisor_*` tables and read queries |
| `POSTGREST_URL` | required | PostgREST base URL; all ledger writes go through its RPCs |
| `FINANCES_TOKEN` | required | Plaintext finances token the daemon logs in with (dedicated row, revocable) |
| `JWT_SECRET` | required | Verifies the web app's JWT (same value PostgREST uses) |
| `PUBLIC_WEB_ORIGINS` | `http://localhost:5173,http://localhost:8080` | CORS allowlist for the web app |
| `WEB_APP_URL` | unset | Public URL of the web app; when set, Discord trackers carry a deep link to the conversation/plan |
| `ADVISOR_CHANNELS` | `web` | Comma list of `web`, `discord`, `gmail` |
| `ADVISOR_ENV` / `PROD_DATABASE_NAME` | `dev` / `finances` | Safety rail: `prod` must point at the prod DB name, anything else must not |
| `PORT` / `MCP_PORT` | `3100` / `3101` | HTTP API (0.0.0.0) and local MCP server (127.0.0.1 only) |
| `DATA_DIR` | `/data` | Statement files and per-conversation workspaces |
| `CLAUDE_BIN`, `CLAUDE_CONFIG_DIR` | `claude`, unset | Claude Code binary and config dir (`~/.claude` when unset) |
| `SESSION_MODEL` / `ROUTINE_MODEL` / `HEALTH_MODEL` | `opus` / `sonnet` / `haiku` | Models for sessions, single-shot routing, health ping |
| `SESSION_EFFORT`, `SESSION_TIMEOUT_MS`, `PLANNING_TURN_TIMEOUT_MS` | `high`, `900000`, `1800000` | Session effort, per-turn timeout for chat, and for a turn that plans a whole statement |
| `MAX_CONCURRENT_SESSIONS` | `2` | Interactive slots; background work has one extra slot and yields |
| `GATE_MAX_7D_PCT`, `GATE_MAX_5H_PCT`, `GATE_MAX_CALLS_PER_WINDOW`, `GATE_TAIL_MINUTES`, `GATE_IDLE_MINUTES` | `85`, `70`, `40`, `60`, `15` | Usage gate for routine work only |
| `STALE_DAYS` | `30` | Accounts unchecked for longer get a nudge |
| `UPLOAD_MAX_MB` | `15` | Upload cap |
| `CHEAP_TICK_MS` / `CLAUDE_TICK_MS` / `GMAIL_TICK_MS` | `900000` / `300000` / `180000` | Scheduler intervals (nudges and pending-plan reminders / Claude background turns / mailbox checks) |
| `TZ` | `UTC` | Time zone for dates in prompts and nudges |
| `ADVISOR_BUDGET_REVIEW` | `false` | Monthly budget review post (off by default) |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`, `DISCORD_OBEYED_USER_IDS` | — | Required when `discord` is enabled |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_LOOKBACK_DAYS` | —, —, —, `14` | Required when `gmail` is enabled |
| `LOG_LEVEL`, `LOG_PRETTY` | `info`, auto | pino level; pretty output on a TTY |

## Claude login and re-auth

The daemon runs `claude -p` as its own user; the login lives in `$HOME/.claude/.credentials.json`
(Linux). The CLI refreshes the token during calls. `GET /health` reports `claude.loggedIn`,
`expiresInHours` and the last health ping; a daily job pings Claude when the credentials expire within
48 h and posts this runbook to Discord if the ping fails:

1. `docker compose exec -it advisor claude login` (or `claude login` as the advisor user)
2. open the printed URL on any device and finish the login
3. `GET /health` shows `claude.loggedIn: true`

To share a login that already exists on the host, bind-mount that user's `~/.claude` to
`/home/advisor/.claude` and build the image with `--build-arg ADVISOR_UID=<uid>` so the container can
write it.

## Discord (optional)

Create a bot application, enable the **Message Content** intent, invite it with *Send Messages*,
*Create Public Threads*, *Read Message History*, *Add Reactions*, *Attach Files*, and set
`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID` (one text channel) and
`DISCORD_OBEYED_USER_IDS` (comma list; everyone else is ignored). Add `discord` to
`ADVISOR_CHANNELS` and restart.

The channel is laid out for a phone. Every topic is one short **tracker** message in the channel,
edited in place as the topic moves along; everything else happens in the topic's thread.

- A message in the channel gets a tracker reply ("⏳ Pensando…") with a thread; the conversation runs
  in the thread and the tracker ends as "✅ Respondido · <first sentence>" (or "⚠️" on failure).
  Messages in a thread are turns; attachments are ingested as uploads (≤ `UPLOAD_MAX_MB`).
- A plan waiting for approval sets the tracker to "🟡 Plano aguardando aprovação" with the counts and
  the balance check, and posts a compact summary in the thread. ✅ on the summary or on the tracker
  (or "aprova", "pode aplicar" in the thread) applies it; "rejeita" rejects. The tracker then reads
  "✅ Aplicado · N lançamentos · conciliação fechada até dd/mm" (or "❌ Plano rejeitado").
- Plans drafted from the web or Gmail that need approval open a tracker + thread in the channel too.
- Replies are reformatted for mobile (one paragraph per line, tables as code blocks) and the assistant is
  told to keep Discord answers to a few lines, offering detail on request.
- Daily notices (accounts unchecked for > `STALE_DAYS`, plans pending > 24 h) are a tracker with a
  one-line status plus the list in the thread; replying in that thread ("Nubank tá com 657,21", "sem
  movimento") runs the check-in. The same notice on the same day edits the tracker instead of posting again.
- Operational alerts (Claude re-auth) are a single short message.

## Accounts from the advisor

Plans may contain `account_create` items (`payload {ref, name, type, subtype, parent_id?}`) and
`account_update` items (`payload {account_id, name?, subtype?, parent_id?, icon?, color?, hidden?}`).
Later items in the same plan reference a new account as `account_id: "new:<ref>"`; the applier
creates the account through PostgREST (`POST /accounts`, reusing an identical existing one) and
substitutes the id before posting the entries. Updating or deleting an entry cleared by a closed
reconciliation needs the item's `reopens_reconciliation` flag; the period is reopened, the clearings
are carried over to the recreated entries, and after apply the period is closed again when it still
balances (or still matches its adjustment). Otherwise it stays open and the apply result says so. Subtypes `property` (asset) and `loan` (liability) keep
an account out of the dashboard money cards and net worth while it stays a normal ledger account.

## Gmail (optional)

`node advisor/ops/gmail-auth.mjs --client-json <downloaded client_secret_*.json>` walks the one-time
consent flow (scope `gmail.readonly`; add `--modify` to let the daemon label processed mail) and writes
`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` to `~/.config/finances-advisor/gmail.env`
(mode 600; `--out` changes the path). Google Cloud side: enable the Gmail API, **publish** the OAuth
consent screen (an app in "Testing" gets refresh tokens that expire after 7 days) and create an OAuth
client: a *Desktop app* client works as is; a *Web application* client must list
`http://127.0.0.1:8765/callback` under its authorized redirect URIs. Put the three values in the
daemon's environment and add `gmail` to `ADVISOR_CHANNELS`.

Skipping the gate (web token): `POST /conversations/:id/plan-now` runs the planning turn of a Gmail
statement that is waiting for the usage gate, right away and as an interactive turn;
`POST /conversations/plan-now` does it for every waiting conversation. Conversation rows carry
`waiting_turn` so the app can offer the button ("Planejar agora").

Manual pick-up (web token): `GET /gmail/messages?q=<gmail query>&limit=20` lists mails with their
attachments, detected institution/kind and whether the sync already handled them;
`POST /gmail/messages/:id/ingest` (`{"force":true}` to redo one, `{"plan":false}` to only store it) ingests that mail and starts the
planning turn right away as an interactive turn, together with whatever else of that account is still
waiting. Of several attachments of one statement (OFX + CSV + PDF) only the preferred one is ingested
unless it yields no lines.

From inside a conversation the session can read the mailbox on demand (`mailbox_check`), see every
statement with `statement_list` and pull waiting mailed ones into the conversation with
`statement_claim`, planning them in the same interactive turn (no gate). A statement the parser could
not read (PDF) gets its period and balances from the session through `statement_set_meta`;
`POST /plans/:id/reconcile` (web token, optional body with period/balances/account) opens the
reconciliation of a plan that was applied before those were known.

Mailed statements are grouped **per account**: a statement joins the conversation of its account
(`external_ref` `gmail:<account_id>`, or `gmail:<institution>:<kind>` until the account is known) as long
as no turn has run there yet, and the title spans the periods ("Nubank conta · 01/07/2026 a
30/09/2026"). The background job starts a conversation's planning turn only once its newest statement
is `SETTLE_SECONDS` (3 min) old, so the initial sync or a burst of re-sent mails is planned in one turn
that plans the oldest period, then chains one turn per remaining period in the same conversation
(each turn gets `PLANNING_TURN_TIMEOUT_MS`), checking continuity between them.

Every cheap tick the daemon walks `users.history` from its cursor (first run: `GMAIL_LOOKBACK_DAYS`
of mail with attachments). Known senders (Nubank account and card statements, Wise) are ingested by
rule; unknown senders with statement-like attachments are routed by a Sonnet single-shot call
(gated). Statements that arrived by mail get their planning turn when the usage gate is open; the
resulting plan is posted to Discord (when enabled) and shows in the web app.

Which ledger account a statement belongs to is learned once: the session asks, and records a note
`statement_source=<institution>:<acctid>` on the account.

## HTTP API (web app)

All routes except `/health` need `Authorization: Bearer <finances JWT>` (the app's login token).

| Route | Purpose |
|---|---|
| `GET /health` | db, claude login, gate, channels, pending plans |
| `GET/POST /conversations`, `GET/PATCH /conversations/:id` | list, create (optionally with a first message), detail (messages, plans, statements) |
| `POST /conversations/:id/messages` | send a turn (202; follow the SSE) |
| `POST /conversations/:id/stop` | abort the running turn |
| `GET /conversations/:id/events` | SSE: message, text deltas, tool activity, status, plan, conversation events |
| `GET /events` | SSE: global plan/statement/health events |
| `POST /uploads`, `POST /conversations/:id/uploads` | multipart `file` (+ `message`) |
| `GET /plans`, `GET /plans/:id` | plans with counts; items with source lines and live balance check |
| `PATCH /plans/:id/items/:itemId` | edit/remove/restore an item (bumps the version) |
| `POST /plans/:id/approve` `{version}` | version-checked approve + apply |
| `POST /plans/:id/reject`, `POST /plans/:id/replan` `{message}` | reject; ask the advisor to revise |
| `GET /accounts/reconciliation-status`, `GET /accounts/:id/reconciliations`, `GET /reconciliations/:id` | reconciliation data for Accounts and Ledger |

## Tests

```bash
npm test                                             # unit: parsers, matcher, gate, runner (fake claude), plan schema, pool
TEST_DATABASE_URL=postgres://…/finances_test npm test # + SQL suite (migrations 0050/0051) and DB-backed matcher tests
```

The SQL suite needs a database with every migration applied (`python scripts/migrate.py` against
it); it runs inside a transaction that is rolled back. Unit tests never call Claude: the runner is
exercised with `test/fixtures/fake-claude.mjs`.

## Layout

See `docs/ADVISOR.md` §4. In short: `src/claude` (credentials, usage gate, runner, sessions),
`src/mcp` (local MCP server and tools), `src/ingest` (parsers, matcher), `src/plan` (schema, applier,
reconciliation), `src/http` (API), `src/discord`, `src/gmail`, `src/jobs`, `prompts/`.
