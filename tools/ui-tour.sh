#!/usr/bin/env bash
# 画面をひととおり開いて撮る。見た目は文章では確かめられない。
set -uo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib-run.sh"
ROM="${1:-/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES}"

(cd "$ROOT" && npm run build >/dev/null 2>&1) || { echo "NG  ビルドに失敗しました"; exit 1; }
run_in_app ":82" "$ROOT/tools/ui-tour.js" "$ROOT/tmp/ui-tour.json" "$ROOT/tmp/ui-tour.log" "$ROM" || exit 1

echo "撮影しました: tmp/tour-*.png"
