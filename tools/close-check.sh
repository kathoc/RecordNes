#!/usr/bin/env bash
# 未保存の記録を抱えたまま閉じようとしたとき、本当に引き止められるかを見る。
#
# ネイティブのダイアログは自動では押せないので、「出たところで止まる」ことで判定する。
# 2 つの場合を両方確かめる。片方だけだと、常に引き止める実装でも通ってしまう。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROM="${1:-${RECORDNES_ROM:-/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES}}"
DISP=":83"
mkdir -p "$ROOT/tmp"

# **必ず作り直してから試す。** 古い dist を相手にすると、直したはずの
# 画面側のコードが混ざらないまま緑になる。
(cd "$ROOT" && npm run build >/dev/null 2>&1) || { echo "NG  ビルドに失敗しました"; exit 1; }

# Xvfb は 1 本だけ立てて使い回す。毎回立て直すと、前のソケットが残っている間に
# 同じ番号で起動できず、2 回目が「X server が無い」で落ちる。
pkill -f "Xvfb $DISP" 2>/dev/null || true
sleep 1
Xvfb "$DISP" -screen 0 800x600x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
trap 'kill $XVFB 2>/dev/null || true' EXIT
sleep 1

run() { # run <ログ名> <引数>
  local name="$1"; shift
  DISPLAY="$DISP" RECORDNES_CLOSE_AFTER=6 \
    timeout 20 "$ROOT/node_modules/.bin/electron" "$ROOT" --no-sandbox "$@" \
    > "$ROOT/tmp/close-$name.log" 2>&1
  echo "$?"
}

fail=0

if [ ! -f "$ROM" ]; then
  echo "SKIP: ROM が無いので確かめられません ($ROM)"
  exit 0
fi

code=$(run unsaved "$ROM")
# 「応答が無いので確認を出します」でも 124 になるので、文言まで見る。
# そちらを合格にすると、未保存の判定が壊れていても気づけない。
if [ "$code" = "124" ] && grep -q "未保存の記録があるので確認を出します" "$ROOT/tmp/close-unsaved.log"; then
  echo "OK  未保存の記録があると引き止められる"
else
  echo "NG  未保存の記録があるのに閉じてしまった (終了コード $code)"
  grep -E "^\[close\]" "$ROOT/tmp/close-unsaved.log" || echo "    (close のログなし)"
  fail=1
fi

code=$(run clean /tmp/recordnes-not-a-rom.txt)
if [ "$code" = "0" ] && grep -q "閉じます" "$ROOT/tmp/close-clean.log"; then
  echo "OK  記録が無ければそのまま閉じる"
else
  echo "NG  記録が無いのに閉じられない (終了コード $code)"
  grep -E "^\[close\]" "$ROOT/tmp/close-clean.log" || echo "    (close のログなし)"
  fail=1
fi

exit $fail
