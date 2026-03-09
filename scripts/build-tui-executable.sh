#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist"
OUT_BIN="$OUT_DIR/companion"

mkdir -p "$OUT_DIR"

echo "Building Companion TUI executable..."
bun build "$ROOT_DIR/apps/tui/src/index.tsx" --compile --outfile "$OUT_BIN"

echo "Executable generated at: $OUT_BIN"
