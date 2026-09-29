#!/usr/bin/env bash
# 画面をひととおり開いて撮る。見た目は文章では確かめられない。
set -uo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib-run.sh"
ROM="${1:-/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES}"

build_or_die || exit 1
# 前回の写真を消す。残すと、途中で落ちても揃って見える。
clear_artifacts "$ROOT"/tmp/tour-*.png
run_in_app ":82" "$ROOT/tools/ui-tour.js" "$ROOT/tmp/ui-tour.json" "$ROOT/tmp/ui-tour.log" "$ROM" || exit 1
report_result "$ROOT/tmp/ui-tour.json" || exit 1
ls -1 "$ROOT"/tmp/tour-*.png
