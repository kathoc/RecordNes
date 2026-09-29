# 画面の中でスクリプトを走らせるための共通部分。
#
# 同じ手順を 4 本に書き写していたら、同じ不具合が 4 本に散った。
# （結果を消さずに走らせて前回の結果で緑になる、結果を読まずに成功と報告する、
#  失敗の理由を捨てる、など）ここ 1 か所に集める。
#
# 使い方:
#   source "$(dirname "$0")/lib-run.sh"
#   build_or_die
#   run_in_app <表示番号> <検証スクリプト> <結果JSON> <ログ> [引数...]
#   report_result <結果JSON>

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"


build_or_die() {
  mkdir -p "$ROOT/tmp"
  # 出力は捨てない。捨てると、型エラーで止まったのか画面が壊れたのか分からない。
  if ! (cd "$ROOT" && npm run build) > "$ROOT/tmp/build.log" 2>&1; then
    echo "NG  ビルドに失敗しました。ログ: tmp/build.log"
    tail -15 "$ROOT/tmp/build.log"
    return 1
  fi
}

# 前回の成果物を消す。残すと、途中で落ちても前回のものが出てきて緑に見える。
clear_artifacts() {
  rm -f "$@" 2>/dev/null || true
}

run_in_app() { # <disp> <script.js> <out.json> <log> [args...]
  local disp="$1" script="$2" out="$3" log="$4"; shift 4
  local udd="$ROOT/tmp/userdata-$$-${disp//:/}"

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

# 結果 JSON を読んで合否を返す。**どのスクリプトも必ずこれを通す。**
# 読まずに「できました」と出すと、中で落ちていても緑になる。
report_result() { # <out.json> [--items]
  python3 - "$1" "${2:-}" <<'PY'
import json, sys
path, mode = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(path))
except Exception as e:
    print(f"NG  結果を読めません: {e}")
    sys.exit(1)

ok = bool(d.get("ok"))
items = d.get("log", [])
print(("PASS" if ok else "FAIL") + (f" / {len(items)} 項目" if items else ""))

# 画面の中で例外が出たときは log が無い。理由を捨てない。
if "error" in d:
    print("  例外: " + str(d["error"]))
for x in items:
    if not x["ok"] or mode == "--items":
        print(("  OK  " if x["ok"] else "  NG  ") + x["name"],
              json.dumps(x.get("detail"), ensure_ascii=False))
sys.exit(0 if ok else 1)
PY
}
