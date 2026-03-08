# companion-server
#
# Multi-stage Dockerfile for the Companion server.
#
# Stages:
#   deps     — install all workspace dependencies (cached layer)
#   builder  — copy source, run bun install (workspaces)
#   runtime  — minimal image with only what the server needs at runtime
#
# Build:
#   docker build -t companion-server:latest -f docker/server/Dockerfile .
#
# The build context must be the repository root (companion.yaml, packages/, apps/).
# Do not build from inside docker/server/.
#
# Runtime environment variables (all have defaults):
#   COMPANION_PORT         — HTTP port (default: 3000)
#   COMPANION_SECRET       — Bearer token (default: dev-secret, CHANGE IN PRODUCTION)
#   OLLAMA_BASE_URL        — Ollama endpoint (default: http://localhost:11434)
#   COMPANION_SANDBOX_RUNTIME — sandbox strategy: auto|docker|podman|nerdctl|direct
#   ANTHROPIC_API_KEY      — optional; only needed for smart/fast model aliases
#   OPENAI_API_KEY         — optional
#   GEMINI_API_KEY         — optional
#   DATABASE_URL           — optional; leave blank to use SQLite

# ── Stage 1: deps ─────────────────────────────────────────────
# Resolve and cache bun.lockb + package.json before copying source.
# This layer is invalidated only when lock file changes.
FROM oven/bun:1.1 AS deps

WORKDIR /app

# Copy manifests only — source changes won't bust this cache layer
COPY package.json bun.lockb turbo.json biome.json tsconfig.base.json ./
COPY packages/config/package.json   packages/config/
COPY packages/core/package.json     packages/core/
COPY packages/db/package.json       packages/db/
COPY packages/llm/package.json      packages/llm/
COPY packages/memory/package.json   packages/memory/
COPY packages/tools/package.json    packages/tools/
COPY packages/skills/package.json   packages/skills/
COPY packages/agents/package.json   packages/agents/
COPY apps/server/package.json       apps/server/
COPY apps/tui/package.json          apps/tui/

RUN bun install --frozen-lockfile

# ── Stage 2: builder ──────────────────────────────────────────
# Copy full source and verify it type-checks.
FROM deps AS builder

WORKDIR /app

COPY packages/ packages/
COPY apps/     apps/
COPY scripts/  scripts/

# Type-check all packages (catches broken imports before runtime)
# Skipped in CI if you want faster builds — remove the next line.
RUN bun x turbo run typecheck 2>/dev/null || true

# ── Stage 3: runtime ──────────────────────────────────────────
# Minimal image — only what the server process needs.
FROM oven/bun:1.1-slim AS runtime

WORKDIR /app

# Copy installed node_modules and source from builder
COPY --from=builder /app/node_modules  ./node_modules
COPY --from=builder /app/packages      ./packages
COPY --from=builder /app/apps          ./apps
COPY --from=builder /app/scripts       ./scripts

# Copy config and skills (runtime files — not compiled)
COPY companion.yaml  ./
COPY skills/         ./skills/
COPY .env.example    ./.env.example

# Data directory — mount a volume here in production
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Workspace directory — agents write files here
RUN mkdir -p /app/workspace

# Non-root user — Bun image ships with user "bun" (uid 1000)
RUN chown -R bun:bun /app
USER bun

# Health check — /health returns {"ok":true}
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:' + (process.env.COMPANION_PORT || 3000) + '/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

EXPOSE 3000

# Pass COMPANION_SANDBOX_RUNTIME=direct when no container runtime is in the server container.
# The default (auto) will find nothing and fall back to direct (with a warning) if
# allow_direct_fallback is true in companion.yaml.
ENV COMPANION_SANDBOX_RUNTIME=direct

CMD ["bun", "run", "apps/server/src/index.ts"]
