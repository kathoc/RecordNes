#!/usr/bin/env bash
# アイコンを作る。32x32 のドット絵として描き、最近傍で 512 まで拡大する。
# NES の絵と同じ扱い方にしておくと、縮小表示でも輪郭が濁らない。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/build/icon-32.png"
convert -size 32x32 xc:none \
  -fill '#12131a' -draw 'roundrectangle 0,0 31,31 6,6' \
  -fill '#ff4d5e' -draw 'circle 12,16 12,8' \
  -fill '#ffcc4d' -draw 'polygon 21,9 21,23 30,16' \
  -fill '#e8eaf2' -draw 'rectangle 4,27 27,28' \
  "$SRC"
convert "$SRC" -filter point -resize 512x512 "$ROOT/build/icon.png"
convert "$SRC" -filter point -resize 256x256 "$ROOT/build/icon-256.png"
echo "作成: build/icon.png (512) と build/icon-256.png"
