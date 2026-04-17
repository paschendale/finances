"""If FINANCES_BOOTSTRAP_TOKEN is set, ensure that plaintext token is registered in auth_tokens (idempotent)."""

import hashlib
import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

env_path = Path(__file__).parent.parent / ".env"
load_dotenv(dotenv_path=env_path)


def main() -> int:
    token = os.environ.get("FINANCES_BOOTSTRAP_TOKEN", "").strip()
    if not token:
        return 0

    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("ensure_bootstrap_token: DATABASE_URL not set", file=sys.stderr)
        return 1

    token_hash = hashlib.sha256(token.encode()).hexdigest()

    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO auth_tokens (token_hash, description)
                VALUES (%s, %s)
                ON CONFLICT (token_hash) DO NOTHING
                """,
                (token_hash, "docker compose bootstrap"),
            )
            inserted = cur.rowcount
        conn.commit()
        if inserted:
            print("ensure_bootstrap_token: registered token from FINANCES_BOOTSTRAP_TOKEN.")
        else:
            print("ensure_bootstrap_token: token already registered (unchanged).")
    finally:
        conn.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
