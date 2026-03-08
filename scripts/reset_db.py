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

def reset_db():
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            print("Resetting database (dropping and recreating public schema)...")
            # The most robust way to reset: drop the entire schema
            cur.execute("DROP SCHEMA public CASCADE;")
            cur.execute("CREATE SCHEMA public;")
            cur.execute("GRANT ALL ON SCHEMA public TO public;")
            cur.execute("COMMENT ON SCHEMA public IS 'standard public schema';")
            
            # PostgREST reload notification
            cur.execute("NOTIFY pgrst, 'reload schema';")
            
            conn.commit()
            print("Database reset successfully (public schema recreated).")
            print("Now run 'python scripts/migrate.py' to restore the schema and functions.")
    except Exception as e:
        conn.rollback()
        print(f"Error resetting database: {e}")
        sys.exit(1)
    finally:
        conn.close()

if __name__ == "__main__":
    confirm = input("This will DELETE ALL DATA and RESET the database schema migrations. Are you sure? (y/N): ")
    if confirm.lower() == 'y':
        reset_db()
    else:
        print("Operation cancelled.")
