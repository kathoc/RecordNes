#!/usr/bin/env bash
# 配布物をそのまま起動し、中で tools/packaged-check.js を走らせる。
# asar の中の preload や、展開が要る ffmpeg が製品でも動くかは、これでしか確かめられない。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROM="${1:-/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES}"
APP=$(ls "$ROOT"/release/*.AppImage 2>/dev/null | head -1)
[ -n "$APP" ] || { echo "NG  release/ に AppImage がありません。先に npm run dist:linux"; exit 1; }
DISP=":81"
OUT="$ROOT/tmp/packaged-check.json"
UDD="$ROOT/tmp/userdata-packaged-$$"
mkdir -p "$ROOT/tmp"
rm -f "$OUT"   # 前回の結果で緑に見せない

pkill -f "Xvfb $DISP" 2>/dev/null || true
sleep 1
Xvfb "$DISP" -screen 0 1280x1000x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
# AppImage は本体を孫プロセスとして起こすので、timeout の signal が届かないことがある。
# 作業ディレクトリで見分けて確実に落とす（置き去りを残さない）。
trap 'kill $XVFB 2>/dev/null || true; pkill -f "$UDD" 2>/dev/null || true; rm -rf "$UDD"' EXIT
sleep 1

DISPLAY="$DISP" \
RECORDNES_SELFTEST="$ROOT/tools/packaged-check.js" \
RECORDNES_SELFTEST_OUT="$OUT" \
RECORDNES_VIDEO_OUT="$ROOT/tmp/packaged-export.mp4" \
RECORDNES_SHOT_DIR="$ROOT/tmp" \
  timeout -k 10 180 "$APP" --appimage-extract-and-run --no-sandbox --recordnes-test-mode \
    --user-data-dir="$UDD" "$ROM" > "$ROOT/tmp/packaged-check.log" 2>&1
CODE=$?
pkill -f "$UDD" 2>/dev/null || true

[ -f "$OUT" ] || { echo "NG  結果が出ませんでした（終了コード $CODE）"; tail -5 "$ROOT/tmp/packaged-check.log"; exit 1; }

python3 - "$OUT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(("PASS" if d.get("ok") else "FAIL"))
for x in d.get("log", []):
    print(("  OK  " if x["ok"] else "  NG  ") + x["name"], json.dumps(x.get("detail"), ensure_ascii=False))
sys.exit(0 if d.get("ok") else 1)
PY
