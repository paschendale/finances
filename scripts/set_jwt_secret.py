import os
import psycopg2
from pathlib import Path
from dotenv import load_dotenv

# Load .env from project root
env_path = Path(__file__).parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

from psycopg2 import sql

def set_jwt_secret():
    db_url = os.getenv("DATABASE_URL")
    jwt_secret = os.getenv("JWT_SECRET")
    
    if not db_url or not jwt_secret:
        print("Error: DATABASE_URL or JWT_SECRET not set in .env")
        return

    conn = psycopg2.connect(db_url)
    try:
        # Get current database name
        with conn.cursor() as cur:
            cur.execute("SELECT current_database()")
            db_name = cur.fetchone()[0]
            
            # Use psycopg2.sql to safely format the statement
            print(f"Setting app.jwt_secret for database '{db_name}'...")
            query = sql.SQL("ALTER DATABASE {db} SET app.jwt_secret = {secret}").format(
                db=sql.Identifier(db_name),
                secret=sql.Literal(jwt_secret)
            )
            cur.execute(query)
            
        conn.commit()
        print("Successfully set app.jwt_secret in the database.")
    except Exception as e:
        print(f"Error setting JWT secret: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    set_jwt_secret()
