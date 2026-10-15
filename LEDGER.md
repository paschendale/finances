# LEDGER.md

Pending issues and unresolved decisions.

---

## `mcp-server` JWT cache is isolate-lifetime only

No KV/Durable Object backing — a module-level `Map` that survives only as long as the same warm V8 isolate. Fine at current (2-user) volume; worst case is one extra `login_with_token` round-trip per tool call. Revisit if tool-call latency becomes noticeable.

## `mcp-server` scope intentionally excludes some frontend endpoints

`app/src/lib/api.ts` also covers accounts/alias CRUD, `global_settings`, `budget_plans` listing, and `get_category_monthly_history` — none of these are in `docs/API_CONTRACT.md`'s catalog, so `mcp-server`'s 21 tools deliberately don't cover them. Add as follow-up tools using the same pattern (`src/tools/*.ts`) if the chatbot use case grows to need them.

## `mcp-server` has no per-person tool scoping

Both household members' tokens grant identical full read/write access via the MCP server, same as the web app today — no read-only vs. read-write distinction was requested. Worth reconsidering only if that ever becomes desirable.

## Advisor: headless Claude Code OAuth in Docker is unproven

`docs/ADVISOR.md` §6.1 relies on the Claude Code CLI refreshing its OAuth token inside a Linux container with no interactive session. A sibling project records the gate closing on token expiry until Claude Code was opened interactively (on a Mac keychain setup). Mitigation: daily health job + re-auth runbook (`docker exec -it … claude login`). If refresh proves unreliable, revisit the API-key fallback declined for v1. Verify subscription terms for unattended use before production cutover.

## Advisor: `ajustes` account type vs `net_worth` definition

Reconciliation adjustments are booked to a root `expense` account `ajustes` (migration 0049) because `daily_balances` computes `net_worth` as asset + liability + equity, which would neutralise an equity-type adjustments account. Decide whether `net_worth` should exclude equity; if so, `ajustes` can become equity.

## Advisor: only one mailbox is watched

The Gmail watcher reads one operator mailbox. Statements from other household members arrive as uploads (web or Discord). Add multi-mailbox support if that becomes a chore.

## Advisor: classifier weights need tuning on real history

`classify_candidates` (docs/ADVISOR.md §21) starts with reasoned default weights (name 0.40, raw 0.20, amount 0.15, account 0.10, time 0.10). They can only be tuned once transactions carry `metadata.statement_line.raw`. After a few statements are applied, evaluate against the maintainer's known categorisations and store the chosen weights in `global_settings.classifier_weights`.

## Advisor: classifier noise on short raw text

On the maintainer's history `classify_candidates('TAMPOPO ALIMENTOS LTDA', …)` ranks the right category first (41 matches) but with confidence ≈ 0.5 because unrelated categories with many recent transactions pass the `name ≥ 0.25` eligibility bar through weak trigram overlap (`alimentos` vs `rendimentos`). Options: raise the eligibility threshold to 0.35, require `word_similarity` rather than `similarity` for the bar, or down-weight categories whose evidence is name-only. Decide after a few applied statements; the weights and thresholds live in `global_settings.classifier_weights`.

## Advisor: Gmail watcher enabled on the dev instance (2026-10-15)

The maintainer's personal mailbox is connected (Desktop OAuth client, scope `gmail.readonly`, consent screen published so the refresh token does not expire). The three `GMAIL_*` values live only in the private infra compose and in `~/.config/finances-advisor/gmail.env` on the maintainer's machine. Production cutover must copy them to the prod service. Labels on processed mail need the `gmail.modify` scope (`--modify` on the helper); not enabled.
## Advisor: Discord bot token still the pre-pilot one

The production bot runs with the token that sits in the infra repo's git history. Rotate it in the Discord Developer Portal (Bot → Reset Token) and update the compose when convenient.

## Advisor: second household member on Discord

`DISCORD_OBEYED_USER_IDS` on the dev instance lists one user id. Add the second member's id so both can approve from Discord (web approvals already work for any finances token).

## Advisor: empty draft plans linger

When every line of a statement is already in the ledger the assistant sometimes calls `plan_create` and then leaves the draft empty (two such drafts on the dev copy from the re-sent September and the duplicate July mails). Harmless, but they show up in plan lists. Options: have `plan_create` require at least one item before it is listed, or a daily job that rejects empty drafts older than a day.

## Advisor: plan review has no "split item" action

The mockup shows a split action on a plan row; the implementation covers it through the "ask the advisor to change this plan" box (the advisor rewrites the items). A direct split needs an "insert item" API on the plan.

## Advisor: shared Claude login between host and container

The dev instance bind-mounts the host user's `~/.claude` so the container and the host share one OAuth login. If both refresh the token concurrently one side may be logged out; watch `GET /health` → `claude.loggedIn` and the daily health ping. A dedicated named volume with its own `claude login` avoids this if it bites.
