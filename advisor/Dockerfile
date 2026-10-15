# syntax=docker/dockerfile:1
# Finances advisor daemon: Node 22 + Claude Code CLI + python3 + poppler.
# Build from the repo root:  docker build -f advisor/Dockerfile -t finances-advisor .

FROM node:22-bookworm-slim AS builder
WORKDIR /src/advisor
COPY advisor/package.json advisor/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY advisor/tsconfig.json ./
COPY advisor/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
ARG ADVISOR_UID=1000
ARG ADVISOR_GID=1000
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 poppler-utils ca-certificates git curl tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force
# The "node" user of the base image owns uid 1000; reuse or create "advisor" with the requested ids
RUN if getent passwd ${ADVISOR_UID} >/dev/null; then \
      usermod -l advisor -d /home/advisor -m "$(getent passwd ${ADVISOR_UID} | cut -d: -f1)" && groupmod -n advisor "$(getent group ${ADVISOR_GID} | cut -d: -f1)" || true; \
    else \
      groupadd -g ${ADVISOR_GID} advisor && useradd -m -u ${ADVISOR_UID} -g ${ADVISOR_GID} -s /bin/bash advisor; \
    fi \
    && mkdir -p /home/advisor/.claude /data /app \
    && chown -R ${ADVISOR_UID}:${ADVISOR_GID} /home/advisor /data /app
WORKDIR /app
COPY --from=builder --chown=${ADVISOR_UID}:${ADVISOR_GID} /src/advisor/node_modules ./node_modules
COPY --from=builder --chown=${ADVISOR_UID}:${ADVISOR_GID} /src/advisor/dist ./dist
COPY --chown=${ADVISOR_UID}:${ADVISOR_GID} advisor/prompts ./prompts
COPY --chown=${ADVISOR_UID}:${ADVISOR_GID} advisor/package.json ./package.json
ENV HOME=/home/advisor \
    NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3100 \
    MCP_PORT=3101 \
    CLAUDE_BIN=claude
USER advisor
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3100/health >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
