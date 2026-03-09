#!/usr/bin/env bash
set -euo pipefail

if ! command -v git >/dev/null 2>&1; then
  echo "git is required to configure hooks"
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${repo_root}" ]]; then
  echo "Not inside a git repository; skipping hook setup"
  exit 0
fi

cd "$repo_root"
mkdir -p .githooks
chmod +x .githooks/pre-commit || true
git config core.hooksPath .githooks

echo "Configured git hooks path: .githooks"
