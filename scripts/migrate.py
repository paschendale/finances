import os
import sys
import psycopg2
from pathlib import Path
from dotenv import load_dotenv

# Load .env from project root
env_path = Path(__file__).parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

def get_connection():
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("Error: DATABASE_URL environment variable not set.")
        sys.exit(1)
    return psycopg2.connect(db_url)

def ensure_migrations_table(conn):
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TIMESTAMP DEFAULT now()
            );
        """)
    conn.commit()

def get_applied_migrations(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT version FROM schema_migrations")
        return {row[0] for row in cur.fetchall()}

def run_migration(conn, migration_file):
    print(f"Applying migration: {migration_file.name}")
    with open(migration_file, "r") as f:
        sql = f.read()

    with conn.cursor() as cur:
        try:
            cur.execute("BEGIN;")
            cur.execute(sql)
            cur.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (migration_file.name,))
            cur.execute("COMMIT;")
        except Exception as e:
            cur.execute("ROLLBACK;")
            print(f"Error applying migration {migration_file.name}: {e}")
            raise e

def reload_postgrest(conn):
    print("Reloading PostgREST schema cache...")
    with conn.cursor() as cur:
        cur.execute("NOTIFY pgrst, 'reload schema';")
    conn.commit()

def main():
    migrations_dir = Path(__file__).parent.parent / "migrations"
    migration_files = sorted(migrations_dir.glob("*.sql"))

    if not migration_files:
        print("No migration files found.")
        return

    conn = get_connection()
    try:
        ensure_migrations_table(conn)
        applied = get_applied_migrations(conn)

        to_apply = [f for f in migration_files if f.name not in applied]

        if not to_apply:
            print("Database is up to date.")
            return

        for migration in to_apply:
            run_migration(conn, migration)

        reload_postgrest(conn)
        print("All migrations applied successfully.")
    finally:
        conn.close()

if __name__ == "__main__":
    main()
