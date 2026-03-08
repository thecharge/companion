#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

pass() { printf '[PASS] %s\n' "$1"; }
warn() { printf '[WARN] %s\n' "$1"; }
fail() { printf '[FAIL] %s\n' "$1"; exit 1; }

command -v bun >/dev/null 2>&1 || fail "bun is required"
pass "bun installed"

if command -v ollama >/dev/null 2>&1; then
  pass "ollama installed"
else
  warn "ollama not installed (required for local mode)"
fi

if [ -f companion.yaml ]; then
  pass "companion.yaml present"
else
  fail "companion.yaml missing"
fi

if grep -q 'secret: .*dev-secret' companion.yaml; then
  warn "companion.yaml uses dev-secret default; set COMPANION_SECRET in production"
else
  pass "server secret not using obvious dev default"
fi

if grep -q 'allow_direct_fallback: true' companion.yaml; then
  warn "sandbox.allow_direct_fallback=true; set false for production"
else
  pass "sandbox direct fallback disabled"
fi

if grep -q 'runtime:.*auto' companion.yaml; then
  warn "sandbox.runtime=auto; pin docker/podman for production"
else
  pass "sandbox runtime pinned"
fi

bun run lint
pass "lint passed"

bun run typecheck
pass "typecheck passed"

bun run test
pass "tests passed"

printf '\nReadiness check completed.\n'
