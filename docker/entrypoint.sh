#!/bin/sh
set -e
cd /opt/finances
python3 scripts/migrate.py
python3 scripts/set_jwt_secret.py
python3 scripts/ensure_bootstrap_token.py
exec nginx -g "daemon off;"
