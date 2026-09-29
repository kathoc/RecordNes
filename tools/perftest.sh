#!/usr/bin/env bash
# 遅延と 1 フレームあたりの計算時間を、実アプリを動かして測る。
set -uo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib-run.sh"
ROM="${1:-/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES}"

(cd "$ROOT" && npm run build >/dev/null 2>&1) || { echo "NG  ビルドに失敗しました"; exit 1; }
run_in_app ":79" "$ROOT/tools/perftest.js" "$ROOT/tmp/perftest.json" "$ROOT/tmp/perftest.log" "$ROM" || exit 1

cat "$ROOT/tmp/perftest.json"
