# finances-mcp

A remote MCP server that exposes the finances PostgREST API as MCP tools, so a chatbot
(Claude, ChatGPT, etc.) can read and write ledger data on behalf of an authenticated user.

Built on `createMcpHandler` (stateless MCP SDK v2, via `agents/mcp/server`) — no Durable
Object, no session state. Every tool call independently exchanges the caller's raw
PostgREST access token for a JWT (`POST /rpc/login_with_token`) and forwards it to
PostgREST, exactly like the web frontend (`app/src/lib/api.ts`).

## Auth

The `/mcp` endpoint requires `Authorization: Bearer <raw token>`, where `<raw token>` is
one of the existing tokens from the `auth_tokens` table (the same ones the web app's
login screen accepts). Generate one per person/device:

```bash
python scripts/generate_token.py "Wife's phone"
```

No separate auth system, no OAuth, no Cloudflare Access — the credential is the raw
token itself.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # point POSTGREST_URL at your local PostgREST (docker compose)
npx wrangler types                # generates worker-configuration.d.ts
npm run dev                       # wrangler dev, serves http://localhost:8787/mcp
```

In another terminal, smoke-test with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
```

Connect to `http://localhost:8787/mcp` (Streamable HTTP) with header
`Authorization: Bearer <raw token>`.

## Tests

```bash
npm test
```

## Deploy

Two environments are defined in `wrangler.jsonc` (`vars` is not inherited between them —
each fully redeclares its own `POSTGREST_URL`):

| Environment | Deploy command | Worker name | `POSTGREST_URL` |
|---|---|---|---|
| production | `npx wrangler deploy --env production` | `finances-mcp-production` | `https://api-finances.marotta.dev` |
| dev | `npx wrangler deploy --env dev` | `finances-mcp-dev` | `https://api-finances-dev.marotta.dev` |

Both are deployed via Cloudflare's Git integration (Workers Builds), not manual CLI
deploys, as **two separate dashboard projects** both connected to the same repo/root
directory. In the Cloudflare dashboard (Marotta e Territorial account), for each:
Workers & Pages → Create → Import a Git repository → `paschendale/finances`, root
directory `mcp-server`, then under Build settings set the **Deploy command** to the
matching row above (the default `npx wrangler deploy` is not used — this repo has no
top-level/default environment). Every push to `main` touching `mcp-server/` auto-deploys
both.

Resulting endpoints: `https://finances-mcp-production.<subdomain>.workers.dev/mcp` and
`https://finances-mcp-dev.<subdomain>.workers.dev/mcp`.
