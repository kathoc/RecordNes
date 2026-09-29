import { test } from "node:test";
import assert from "node:assert/strict";
import { Turbo, HOLD_DELAY_FRAMES } from "../src/input/turbo.ts";
import { DpadFilter } from "../src/input/dpad.ts";
import { BTN } from "../src/core/emu.ts";

test("連射 OFF では、連射ボタンが普通の A / B として働く", () => {
  const t = new Turbo();
  t.setMode("off");
  for (let f = 0; f < 10; f++) assert.equal(t.tick("A", true, f), true);
  assert.equal(t.tick("A", false, 10), false);
});

test("ホールド連射は 0.5 秒だけ単押しで、そのあと指定の周期になる", () => {
  const t = new Turbo();
  t.setMode("hold");
  t.setRate(15); // 半周期 2 フレーム
  for (let f = 0; f < HOLD_DELAY_FRAMES; f++) {
    assert.equal(t.tick("A", true, f), true, `frame ${f} は単押しの区間`);
  }
  const after: boolean[] = [];
  for (let f = HOLD_DELAY_FRAMES; f < HOLD_DELAY_FRAMES + 8; f++) after.push(t.tick("A", true, f));
  assert.deepEqual(after, [true, true, false, false, true, true, false, false]);
  assert.equal(t.tick("A", false, 100), false, "離せば止まる");
});

test("トグル連射は、離しても続き、もう一度押すと止まる", () => {
  const t = new Turbo();
  t.setMode("toggle");
  t.setRate(15);
  assert.equal(t.tick("A", true, 0), true, "押した瞬間から連射が始まる");
  assert.equal(t.latched("A"), true);
  const seq: boolean[] = [];
  for (let f = 1; f < 9; f++) seq.push(t.tick("A", false, f)); // 離していても続く
  assert.deepEqual(seq, [true, false, false, true, true, false, false, true]);
  t.tick("A", true, 9); // もう一度押す
  assert.equal(t.latched("A"), false);
  assert.equal(t.tick("A", false, 10), false, "止まる");
});

test("連射速度を変えると周期が変わる", () => {
  const t = new Turbo();
  t.setMode("toggle");
  t.setRate(30); // 半周期 1 フレーム
  t.tick("A", true, 0);
  const seq: boolean[] = [];
  for (let f = 1; f < 7; f++) seq.push(t.tick("A", false, f));
  assert.deepEqual(seq, [false, true, false, true, false, true]);
});

test("連射の位相はフレーム番号で決まる（実時間に依存しない）", () => {
  const a = new Turbo(); a.setMode("toggle"); a.setRate(15);
  const b = new Turbo(); b.setMode("toggle"); b.setRate(15);
  a.tick("A", true, 0);
  b.tick("A", true, 0);
  // b は「スロー再生で実時間が 10 倍かかった」つもりで、同じフレーム列を辿る。
  for (let f = 1; f < 40; f++) {
    assert.equal(a.tick("A", false, f), b.tick("A", false, f), `frame ${f}`);
  }
});

test("8-way は斜めをそのまま通す", () => {
  const d = new DpadFilter();
  d.setWays(8);
  assert.equal(d.applyDigital(BTN.UP | BTN.RIGHT), BTN.UP | BTN.RIGHT);
});

test("4-way は、後から押した軸だけを残す", () => {
  const d = new DpadFilter();
  d.setWays(4);
  assert.equal(d.applyDigital(BTN.RIGHT), BTN.RIGHT);
  // 右を押したまま上を足す → 上が新しいので上が残る
  assert.equal(d.applyDigital(BTN.RIGHT | BTN.UP), BTN.UP);
  // 上を離して右だけに戻る
  assert.equal(d.applyDigital(BTN.RIGHT), BTN.RIGHT);
});

test("4-way のアナログスティックは、倒れている量が大きい軸を残す", () => {
  const d = new DpadFilter();
  d.setWays(4);
  assert.equal(d.applyAnalog(0.9, 0.4), BTN.RIGHT);
  assert.equal(d.applyAnalog(0.4, -0.9), BTN.UP);
  assert.equal(d.applyAnalog(0.1, 0.1), 0, "デッドゾーン内は無入力");
  d.setWays(8);
  assert.equal(d.applyAnalog(0.9, 0.9), BTN.RIGHT | BTN.DOWN);
});
