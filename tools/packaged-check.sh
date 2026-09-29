#!/usr/bin/env bash
# 配布物をそのまま起動し、中で tools/packaged-check.js を走らせる。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROM="${1:-/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES}"
APP=$(ls "$ROOT"/release/*.AppImage | head -1)
DISP=":81"
mkdir -p "$ROOT/tmp"
pkill -f "Xvfb $DISP" 2>/dev/null || true
Xvfb "$DISP" -screen 0 1280x1000x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
trap 'kill $XVFB 2>/dev/null || true' EXIT
sleep 1
DISPLAY="$DISP" \
RECORDNES_SELFTEST="$ROOT/tools/packaged-check.js" \
RECORDNES_SELFTEST_OUT="$ROOT/tmp/packaged-check.json" \
RECORDNES_VIDEO_OUT="$ROOT/tmp/packaged-export.mp4" \
RECORDNES_SHOT_DIR="$ROOT/tmp" \
  "$APP" --appimage-extract-and-run --no-sandbox --recordnes-test-mode "$ROM" > "$ROOT/tmp/packaged-check.log" 2>&1 || true
cat "$ROOT/tmp/packaged-check.json" 2>/dev/null || echo "(結果ファイルがありません)"
