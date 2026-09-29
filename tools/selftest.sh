#!/usr/bin/env bash
# 実アプリを Xvfb 上で起動し、tools/selftest.js を画面の中で走らせる。
set -uo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib-run.sh"
ROM="${1:-/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES}"

(cd "$ROOT" && npm run build >/dev/null 2>&1) || { echo "NG  ビルドに失敗しました"; exit 1; }
run_in_app ":78" "$ROOT/tools/selftest.js" "$ROOT/tmp/selftest.json" "$ROOT/tmp/selftest.log" "$ROM" || exit 1

python3 - "$ROOT/tmp/selftest.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(("PASS" if d.get("ok") else "FAIL"), f"/ {len(d.get('log', []))} 項目")
for x in d.get("log", []):
    if not x["ok"]:
        print("  NG " + x["name"], json.dumps(x.get("detail"), ensure_ascii=False))
sys.exit(0 if d.get("ok") else 1)
PY
