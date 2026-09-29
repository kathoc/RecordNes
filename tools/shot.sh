#!/usr/bin/env bash
# Xvfb 上でアプリを起動し、画面を撮る。見た目の確認を毎回同じ手順で行うため。
#   tools/shot.sh <出力png> [秒] [引数...]
set -euo pipefail
OUT="${1:?出力ファイルを指定してください}"; shift
WAIT="${1:-10}"; shift || true
DISP=":77"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pkill -f "Xvfb $DISP" 2>/dev/null || true
Xvfb "$DISP" -screen 0 1280x1000x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
sleep 1
DISPLAY="$DISP" "$ROOT/node_modules/.bin/electron" "$ROOT" --no-sandbox "$@" > "$ROOT/tmp/electron.log" 2>&1 &
APP=$!
sleep "$WAIT"
DISPLAY="$DISP" import -window root "$OUT"
kill "$APP" 2>/dev/null || true
sleep 1
kill "$XVFB" 2>/dev/null || true
echo "撮影: $OUT"
