#!/usr/bin/env bash
# 実アプリを Xvfb 上で起動し、tools/perftest.js を画面の中で走らせる。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROM="${1:-/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES}"
DISP=":79"
mkdir -p "$ROOT/tmp"
pkill -f "Xvfb $DISP" 2>/dev/null || true
Xvfb "$DISP" -screen 0 1280x1000x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
trap 'kill $XVFB 2>/dev/null || true; rm -rf "$ROOT/tmp/userdata-$$"' EXIT
sleep 1
DISPLAY="$DISP" \
RECORDNES_UNCAP="${RECORDNES_UNCAP:-0}" \
RECORDNES_SELFTEST="$ROOT/tools/perftest.js" \
RECORDNES_SELFTEST_OUT="$ROOT/tmp/perftest.json" \
RECORDNES_SHOT_DIR="$ROOT/tmp" \
  "$ROOT/node_modules/.bin/electron" "$ROOT" --no-sandbox \
    --user-data-dir="$ROOT/tmp/userdata-$$" "$ROM" > "$ROOT/tmp/perftest.log" 2>&1 || true
echo "--- 結果 ---"
cat "$ROOT/tmp/perftest.json" 2>/dev/null || echo "(結果ファイルがありません)"
