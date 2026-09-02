# LEDGER.md

Pending issues and unresolved decisions.

---

## `mcp-server` JWT cache is isolate-lifetime only

No KV/Durable Object backing — a module-level `Map` that survives only as long as the same warm V8 isolate. Fine at current (2-user) volume; worst case is one extra `login_with_token` round-trip per tool call. Revisit if tool-call latency becomes noticeable.

## `mcp-server` scope intentionally excludes some frontend endpoints

`app/src/lib/api.ts` also covers accounts/alias CRUD, `global_settings`, `budget_plans` listing, and `get_category_monthly_history` — none of these are in `docs/API_CONTRACT.md`'s catalog, so `mcp-server`'s 21 tools deliberately don't cover them. Add as follow-up tools using the same pattern (`src/tools/*.ts`) if the chatbot use case grows to need them.

## `mcp-server` has no per-person tool scoping

Both household members' tokens grant identical full read/write access via the MCP server, same as the web app today — no read-only vs. read-write distinction was requested. Worth reconsidering only if that ever becomes desirable.
