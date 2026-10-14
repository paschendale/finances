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
