# Release workflow

Releases are automated with GitHub Actions and [semantic-release](https://github.com/semantic-release/semantic-release).

## Flow

1. **On every push to `main`**, the [Release](.github/workflows/release.yml) workflow runs.
2. The runner **connects to your Tailnet** via the Tailscale action so it can reach the production database.
3. **Semantic-release** analyzes commits (using [Conventional Commits](https://www.conventionalcommits.org/)) and, if there are release-worthy changes, creates a new GitHub release (tag + release notes) and bumps the version in the root `package.json`.
4. **When a new release is created**, the workflow runs migrations (`scripts/run_migration_with_notify.py` → `scripts/migrate.py`) against the production database. Only pending migrations are applied.
5. **If the migration fails**, the job fails and a **Discord notification** is sent (via the configured webhook) with a markdown summary and a reminder that `TAILSCALE_AUTH_KEY` expires after 90 days.

## Required setup

### Repository secrets

- **`DATABASE_URL`** – Production Postgres connection string (e.g. `postgres://user:password@host:5432/dbname`). The database must be reachable from your Tailnet (e.g. host is a Tailscale machine name or Tailscale IP).
- **`TAILSCALE_AUTH_KEY`** – Auth key from the [Tailscale admin console](https://login.tailscale.com/admin/settings/keys) (reusable, ephemeral, with tag identity recommended). **Keys expire after 90 days**; when the migration step starts failing, regenerate a key and update this secret.
- **`DISCORD_WEBHOOK_URL`** – Incoming webhook URL for the channel where migration failures should be reported (e.g. `https://discord.com/api/webhooks/...`).

### Root package.json

- Update the `repository` field in the root `package.json` to your real GitHub repo URL (replace `your-org` with your org or username). This is used by semantic-release for release metadata; in CI the repo is inferred from the checkout.

### Conventional commits

Use conventional commit messages so semantic-release can decide the next version:

- `fix:` or `fix(scope):` → patch (e.g. 1.0.0 → 1.0.1)
- `feat:` or `feat(scope):` → minor (e.g. 1.0.0 → 1.1.0)
- `BREAKING CHANGE:` in body or footer, or `feat!:` → major (e.g. 1.0.0 → 2.0.0)

Examples:

```
fix: correct balance calculation in dashboard
feat(api): add filter by date range
feat!: drop support for legacy import format
```

## When migrations run

Migrations run in two cases:

1. **On release** – When semantic-release creates a new release (tag + GitHub release), the release workflow runs migrations via the exec plugin so production is updated with the new version.
2. **On `migrations/` changes** – The [Migrate](.github/workflows/migrate.yml) workflow runs on every push to `main` that touches files under `migrations/`. This applies new migrations to production even when no new app release is cut (e.g. schema-only or data migrations).
