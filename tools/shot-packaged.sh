#!/usr/bin/env bash
# 配布物（AppImage）をそのまま起動して撮る。asar の中の preload や、
# 展開が要る ffmpeg が製品でも動くかは、これでしか確かめられない。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?出力ファイル}"; WAIT="${2:-14}"; shift 2 || true
APP=$(ls "$ROOT"/release/*.AppImage | head -1)
DISP=":80"
pkill -f "Xvfb $DISP" 2>/dev/null || true
Xvfb "$DISP" -screen 0 1280x1000x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
trap 'kill $XVFB 2>/dev/null || true' EXIT
sleep 1
DISPLAY="$DISP" "$APP" --appimage-extract-and-run --no-sandbox "$@" > "$ROOT/tmp/packaged.log" 2>&1 &
PID=$!
sleep "$WAIT"
DISPLAY="$DISP" import -window root "$OUT"
kill "$PID" 2>/dev/null || true
sleep 1
echo "撮影: $OUT"
