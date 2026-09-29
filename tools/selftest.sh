#!/usr/bin/env bash
# 実アプリを Xvfb 上で起動し、tools/selftest.js を画面の中で走らせる。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROM="${1:-/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES}"
DISP=":78"
mkdir -p "$ROOT/tmp"
pkill -f "Xvfb $DISP" 2>/dev/null || true
Xvfb "$DISP" -screen 0 1280x1000x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
trap 'kill $XVFB 2>/dev/null || true; rm -rf "$ROOT/tmp/userdata-$$"' EXIT
sleep 1
DISPLAY="$DISP" \
RECORDNES_SELFTEST="$ROOT/tools/selftest.js" \
RECORDNES_SELFTEST_OUT="$ROOT/tmp/selftest.json" \
RECORDNES_SHOT_DIR="$ROOT/tmp" \
RECORDNES_SAVE_DIR="$ROOT/tmp" \
  timeout 180 "$ROOT/node_modules/.bin/electron" "$ROOT" --no-sandbox --recordnes-test-mode \
    --user-data-dir="$ROOT/tmp/userdata-$$" "$ROM" > "$ROOT/tmp/selftest.log" 2>&1 || true
echo "--- 結果 ---"
cat "$ROOT/tmp/selftest.json" 2>/dev/null || echo "(結果ファイルがありません)"
