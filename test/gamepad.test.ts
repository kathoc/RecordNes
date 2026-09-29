import { test } from "node:test";
import assert from "node:assert/strict";
import { Pad, PAD } from "../src/input/gamepad.ts";
import { InputManager } from "../src/input/manager.ts";
import { BTN } from "../src/core/emu.ts";

/** 実機のコントローラーがこの開発機に無いので、Gamepad API の形だけを作って
 *  経路を確かめる。**これは実物での確認の代わりにはならない**が、割り当ての
 *  取り違えやコンビネーションの取りこぼしはここで捕まえられる。 */
function fakePad(pressed: number[] = [], axes: number[] = [0, 0]): Gamepad {
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: pressed.includes(i), touched: false, value: pressed.includes(i) ? 1 : 0,
  }));
  return { index: 0, id: "fake", connected: true, mapping: "standard", buttons, axes, timestamp: 0 } as unknown as Gamepad;
}

function install(pads: (Gamepad | null)[]): void {
  // Node の navigator は getter しか無いので、定義し直す。
  Object.defineProperty(globalThis, "navigator", {
    value: { getGamepads: () => pads },
    configurable: true,
    writable: true,
  });
}

test("通常時: 十字キーと A / B / START / SELECT が正しく割り当たる", () => {
  install([fakePad([PAD.RIGHT, PAD.A, PAD.START])]);
  const p = new Pad();
  p.poll();
  assert.equal(p.connected, true);
  assert.equal(p.padBits(), BTN.RIGHT | BTN.A | BTN.START);
  assert.equal(p.comboHeld, false);
});

test("通常時: X / Y は A / B の連射ボタンとして扱われ、そのままでは押されない", () => {
  install([fakePad([PAD.X, PAD.Y])]);
  const p = new Pad();
  p.poll();
  assert.equal(p.padBits(), 0, "X / Y は直接のボタン入力にならない");
  assert.equal(p.turboHeld("A"), true, "X は A 連射");
  assert.equal(p.turboHeld("B"), true, "Y は B 連射");
});

test("L を押している間は、ゲームへ入力が流れない", () => {
  install([fakePad([PAD.L, PAD.RIGHT, PAD.A])]);
  const p = new Pad();
  p.poll();
  assert.equal(p.comboHeld, true);
  assert.equal(p.padBits(), 0, "L 中はゲームに届かない");
});

test("L + ← / → は押している間の操作として出る", () => {
  install([fakePad([PAD.L, PAD.LEFT])]);
  const p = new Pad();
  p.poll();
  assert.deepEqual([...p.heldCommands()], ["rewind"]);
  install([fakePad([PAD.L, PAD.RIGHT])]);
  p.poll();
  assert.deepEqual([...p.heldCommands()], ["fastForward"]);
});

test("L + 各ボタンが、立ち上がりで 1 回だけ機能を出す", () => {
  const cases: [number, string][] = [
    [PAD.A, "frameAdvance"], [PAD.B, "pauseToggle"],
    [PAD.X, "saveState"], [PAD.Y, "loadState"],
    [PAD.START, "reset"], [PAD.SELECT, "saveRecording"], [PAD.R, "marker"],
    [PAD.UP, "speedUp"], [PAD.DOWN, "speedDown"],
  ];
  for (const [btn, cmd] of cases) {
    const p = new Pad();
    install([fakePad([PAD.L])]);
    p.poll();
    p.takeEdges();
    install([fakePad([PAD.L, btn])]);
    p.poll();
    assert.deepEqual(p.takeEdges(), [cmd], `L + ${btn}`);
    p.poll(); // 押しっぱなしでは繰り返さない
    assert.deepEqual(p.takeEdges(), [], `L + ${btn} は押しっぱなしで繰り返さない`);
  }
});

test("L 単独では何も起きない", () => {
  const p = new Pad();
  install([fakePad([])]);
  p.poll();
  install([fakePad([PAD.L])]);
  p.poll();
  assert.deepEqual(p.takeEdges(), []);
  assert.deepEqual([...p.heldCommands()], []);
  install([fakePad([])]);
  p.poll();
  assert.deepEqual(p.takeEdges(), [], "離しても何も起きない");
});

test("十字キーが無いパッドでは、左スティックが十字キーになる", () => {
  install([fakePad([], [-0.9, 0.8])]);
  const p = new Pad();
  p.poll();
  assert.equal(p.padBits(), BTN.LEFT | BTN.DOWN);
});

test("2 台目のコントローラーが 2P になる", () => {
  install([fakePad([PAD.A]), fakePad([PAD.LEFT, PAD.B])]);
  const m = new InputManager();
  const snap = m.sample(0);
  assert.equal(snap.pads[0], BTN.A, "1P");
  assert.equal(snap.pads[1], BTN.LEFT | BTN.B, "2P");
  assert.equal(m.twoPlayers, true);
});

test("2P 側の L でも機能を出せる", () => {
  const m = new InputManager();
  install([fakePad([]), fakePad([PAD.L])]);
  m.sample(0);
  install([fakePad([]), fakePad([PAD.L, PAD.B])]);
  const snap = m.sample(1);
  assert.deepEqual(snap.edges, ["pauseToggle"]);
});

test("パッドが抜けたら、握ったままの入力が残らない", () => {
  const p = new Pad();
  install([fakePad([PAD.RIGHT])]);
  p.poll();
  assert.notEqual(p.padBits(), 0);
  install([]);
  p.poll();
  assert.equal(p.connected, false);
  assert.equal(p.padBits(), 0);
  assert.deepEqual([...p.heldCommands()], []);
});
