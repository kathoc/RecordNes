#!/usr/bin/env bash
# 遅延と 1 フレームあたりの計算時間を、実アプリを動かして測る。
set -uo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib-run.sh"
ROM="${1:-/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES}"

build_or_die || exit 1
run_in_app ":79" "$ROOT/tools/perftest.js" "$ROOT/tmp/perftest.json" "$ROOT/tmp/perftest.log" "$ROM" || exit 1
# 測定値そのものは ok を持たないので、例外が無いことだけ確かめてから中身を出す。
python3 - "$ROOT/tmp/perftest.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if "error" in d:
    print("NG  測定できませんでした: " + str(d["error"]))
    sys.exit(1)
print(json.dumps(d, ensure_ascii=False, indent=2))
PY
