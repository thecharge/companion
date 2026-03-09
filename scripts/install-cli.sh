#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${COMPANION_BIN_DIR:-$HOME/.local/bin}"
TARGET_BIN="$TARGET_DIR/companion"
SOURCE_BIN="$ROOT_DIR/dist/companion"

if [[ ! -f "$SOURCE_BIN" ]]; then
  "$ROOT_DIR/scripts/build-tui-executable.sh"
fi

mkdir -p "$TARGET_DIR"
install -m 0755 "$SOURCE_BIN" "$TARGET_BIN"

echo "Installed companion CLI to: $TARGET_BIN"
if [[ ":$PATH:" != *":$TARGET_DIR:"* ]]; then
  echo "Note: add this directory to PATH: $TARGET_DIR"
fi
