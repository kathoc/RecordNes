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

# 測定結果を出す。合否を持たない JSON 用。読めなければ NG。
report_metrics() { # <out.json>
  python3 - "$1" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"NG  結果を読めません（途中で切れている可能性があります）: {e}")
    sys.exit(1)
if "error" in d:
    print("NG  測定できませんでした: " + str(d["error"]))
    sys.exit(1)
print(json.dumps(d, ensure_ascii=False, indent=2))
PY
}

# 撮った画像がちゃんと絵になっているかを見る。
# capturePage が空を返すと、例外は出ないまま 0 バイトの PNG が並ぶ。
#
# 判定は 2 つ。**どちらも量子化深度に依存しない形で取る**
# （%[standard-deviation] の生値は Q8 ビルドと Q16 ビルドで 256 倍違い、
#  しきい値を数値で置くと環境によって全部落ちるか全部通るかになる）。
#
#   - 色数 (%k): 画面写真なら数千色ある。真っ黒や小さな破片だけなら数色
#   - 正規化した標準偏差 (%[fx:standard_deviation]): 0〜1 で返る
check_images() { # <png...>
  if ! command -v identify >/dev/null 2>&1; then
    echo "NG  identify (ImageMagick) が無いので、画像を確かめられません"
    return 1
  fi
  local bad=0 f info colors sd
  for f in "$@"; do
    if [ ! -s "$f" ]; then
      echo "NG  $f が空です"
      bad=1
      continue
    fi
    if ! info=$(identify -format "%w %h %k %[fx:standard_deviation]" "$f" 2>&1); then
      echo "NG  $f を画像として読めません: $info"
      bad=1
      continue
    fi
    read -r w h colors sd <<<"$info"
    if [ "${w:-0}" -lt 100 ] 2>/dev/null || [ "${h:-0}" -lt 100 ] 2>/dev/null; then
      echo "NG  $f の大きさが不正です (${w}x${h})"
      bad=1
      continue
    fi
    # 数値で返らない環境では、黙って合格にしない。
    if ! python3 -c "
import sys
try:
    colors, sd = int(sys.argv[1]), float(sys.argv[2])
except ValueError:
    print('  (色数か標準偏差を数値として読めません: %r %r)' % (sys.argv[1], sys.argv[2]))
    sys.exit(2)
sys.exit(0 if colors >= 64 and sd >= 0.02 else 1)
" "$colors" "$sd"; then
      echo "NG  $f が絵になっていません (色数 $colors / 標準偏差 $sd)"
      bad=1
    fi
  done
  return $bad
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
