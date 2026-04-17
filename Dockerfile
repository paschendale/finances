# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS frontend-builder
WORKDIR /src/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
ARG VITE_APP_API_URL=http://localhost:3000
ENV VITE_APP_API_URL=${VITE_APP_API_URL}
RUN npm run build

FROM python:3.12-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx wget \
    && rm -rf /etc/nginx/sites-enabled/default \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/finances
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY migrations/ ./migrations/
COPY scripts/migrate.py scripts/set_jwt_secret.py scripts/generate_token.py scripts/ensure_bootstrap_token.py ./scripts/

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-builder /src/app/dist /var/www/html

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
