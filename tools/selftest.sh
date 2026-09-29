#!/usr/bin/env bash
# 実アプリを Xvfb 上で起動し、tools/selftest.js を画面の中で走らせる。
set -uo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib-run.sh"
ROM="${1:-/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES}"

build_or_die || exit 1
clear_artifacts "$ROOT"/tmp/selftest-*.png
run_in_app ":78" "$ROOT/tools/selftest.js" "$ROOT/tmp/selftest.json" "$ROOT/tmp/selftest.log" "$ROM" || exit 1
report_result "$ROOT/tmp/selftest.json"
