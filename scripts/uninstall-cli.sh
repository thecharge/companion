#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${COMPANION_BIN_DIR:-$HOME/.local/bin}"
TARGET_BIN="$TARGET_DIR/companion"

if [[ -f "$TARGET_BIN" ]]; then
  rm -f "$TARGET_BIN"
  echo "Removed $TARGET_BIN"
else
  echo "No installed companion binary found at $TARGET_BIN"
fi
