import os
import secrets
import hashlib
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
        return None
    return psycopg2.connect(db_url)

def generate_token(description):
    token = secrets.token_urlsafe(32)
    # Match the SQL digest(token, 'sha256') behavior
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    
    conn = get_connection()
    if not conn:
        return
    
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO auth_tokens (token_hash, description) VALUES (%s, %s)",
                (token_hash, description)
            )
        conn.commit()
        print(f"Token generated successfully!")
        print(f"Description: {description}")
        print(f"Token: {token}")
        print("-" * 60)
        print("CRITICAL: SAVE THIS TOKEN NOW. IT WILL NOT BE SHOWN AGAIN.")
        print("You will use this token to login in the web interface.")
        print("-" * 60)
    except Exception as e:
        print(f"Error generating token: {e}")
    finally:
        conn.close()

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python scripts/generate_token.py 'Description of the token'")
        sys.exit(1)
    
    desc = sys.argv[1]
    generate_token(desc)
