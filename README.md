# Finances

Personal Ledger System (Postgres-first architecture)

## Stack

- **Frontend:** React (Vite, TypeScript, TailwindCSS v4, shadcn/ui)
- **API:** PostgREST
- **Database:** PostgreSQL

## Setup

1.  Clone the repository.
2.  Install frontend dependencies: `cd app && npm install`.
3.  Configure environment: Copy `.env.example` to `.env` and fill in `DATABASE_URL`, `JWT_SECRET`, and `VITE_APP_API_URL`.
4.  Run database migrations: `python scripts/migrate.py`.
5.  Set database JWT secret: `python scripts/set_jwt_secret.py`.
6.  Generate an initial access token: `python scripts/generate_token.py 'My Initial Token'`.
7.  Start frontend: `cd app && npm run dev`.

## Authentication

The system is protected by token-based authentication.

### Generate new tokens

Use the Python script to generate new access tokens:

```bash
python scripts/generate_token.py "Description of the token"
```

The script will provide the token once. Save it safely.

### Security Notes

-   Tokens are hashed in the database using SHA-256.
-   JWTs expire after 7 days.
-   Login is handled via a secure Postgres RPC.
-   Permissions are enforced using database roles (`anon` and `authenticated`).

## PostgREST Configuration

Ensure your PostgREST server is configured with:

```ini
db-anon-role = "anon"
jwt-secret = "your-secret-from-env"
```

## Maintenance

-   `scripts/migrate.py`: Run database migrations.
-   `scripts/seed.py`: Seed the database with sample data.
-   `scripts/import_excel.py`: Import data from Excel.
-   `scripts/reset_db.py`: Wipe all data and reset the database.
