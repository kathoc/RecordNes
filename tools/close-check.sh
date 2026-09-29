#!/usr/bin/env bash
# 未保存の記録を抱えたまま閉じようとしたとき、本当に引き止められるかを見る。
# ネイティブのダイアログは自動では押せないので、「出たところで止まる」ことを確認する。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROM="${1:-/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES}"
DISP=":83"
mkdir -p "$ROOT/tmp"
pkill -f "Xvfb $DISP" 2>/dev/null || true
Xvfb "$DISP" -screen 0 1280x1000x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
trap 'kill $XVFB 2>/dev/null || true' EXIT
sleep 1
DISPLAY="$DISP" RECORDNES_CLOSE_AFTER="${CLOSE_AFTER:-6}" \
  timeout 20 "$ROOT/node_modules/.bin/electron" "$ROOT" --no-sandbox "$ROM" > "$ROOT/tmp/close-check.log" 2>&1
CODE=$?
echo "終了コード: $CODE  (124 = 引き止められたまま時間切れ = 期待どおり)"
grep -E "^\[close\]" "$ROOT/tmp/close-check.log" || echo "(close のログなし)"
