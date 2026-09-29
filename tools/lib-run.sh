# 画面の中でスクリプトを走らせるための共通部分。
#
# 同じ手順を 4 本に書き写していたら、同じ不具合が 4 本に散った。
# （結果ファイルを消さずに走らせ、落ちたときに前回の結果で緑になる、など）
# ここ 1 か所に集める。
#
# 使い方:
#   source "$(dirname "$0")/lib-run.sh"
#   run_in_app <表示番号> <検証スクリプト> <結果JSON> <ログ> [引数...]

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_in_app() { # <disp> <script.js> <out.json> <log> [args...]
  local disp="$1" script="$2" out="$3" log="$4"; shift 4
  local udd="$ROOT/tmp/userdata-$$-${disp//:/}"

  # **前回の結果を必ず消す。** 残したまま走らせると、途中で落ちても
  # 前回の結果が読まれて緑に見える。
  rm -f "$out"
  mkdir -p "$ROOT/tmp"

  pkill -f "Xvfb $disp" 2>/dev/null || true
  sleep 1
  Xvfb "$disp" -screen 0 1280x1000x24 -nolisten tcp >/dev/null 2>&1 &
  local xvfb=$!
  # 置き去りを残さない。--appimage-extract-and-run は孫プロセスになるので、
  # timeout の signal が本体へ届かないことがある。作業ディレクトリで見分けて落とす。
  trap 'kill '"$xvfb"' 2>/dev/null || true; pkill -f "'"$udd"'" 2>/dev/null || true; rm -rf "'"$udd"'"' EXIT
  sleep 1

  DISPLAY="$disp" \
  RECORDNES_SELFTEST="$script" \
  RECORDNES_SELFTEST_OUT="$out" \
  RECORDNES_SHOT_DIR="$ROOT/tmp" \
  RECORDNES_SAVE_DIR="$ROOT/tmp" \
    timeout -k 10 180 "$ROOT/node_modules/.bin/electron" "$ROOT" \
      --no-sandbox --recordnes-test-mode --user-data-dir="$udd" "$@" \
      > "$log" 2>&1
  local code=$?
  pkill -f "$udd" 2>/dev/null || true

  if [ ! -f "$out" ]; then
    echo "NG  結果が出ませんでした（終了コード $code）。ログ: $log"
    tail -5 "$log"
    return 1
  fi
  return 0
}
