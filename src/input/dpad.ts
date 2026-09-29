/** 十字キーの 4-way / 8-way。
 *
 *  斜めを一切読まないゲームでは、斜めが出ること自体が雑音になる。brickboy と
 *  同じ考え方で、4-way のときは斜めを 1 方向へ丸める。ROM ごとに設定を覚える。
 *
 *  丸め方は入力源で変える。
 *  - キーボードやデジタル十字キー: 後から押した軸を残す。歩きながら向きを変える操作が自然になる
 *  - アナログスティック: 倒れている量が大きい軸を残す */

import { BTN } from "../core/emu.ts";

export type Ways = 4 | 8;

const VERTICAL = BTN.UP | BTN.DOWN;
const HORIZONTAL = BTN.LEFT | BTN.RIGHT;

export class DpadFilter {
  ways: Ways = 8;
  /** 直近に軸が立ち上がった順。"v" が新しければ縦を残す */
  private newer: "v" | "h" | null = null;
  private prevV = false;
  private prevH = false;

  setWays(w: Ways): void {
    this.ways = w;
  }

  /** デジタル入力の丸め。`byte` は 8 ビットの入力。 */
  applyDigital(byte: number): number {
    const v = (byte & VERTICAL) !== 0;
    const h = (byte & HORIZONTAL) !== 0;
    if (v && !this.prevV) this.newer = "v";
    if (h && !this.prevH) this.newer = "h";
    this.prevV = v;
    this.prevH = h;
    if (this.ways === 8 || !v || !h) return byte;
    return this.newer === "v" ? byte & ~HORIZONTAL : byte & ~VERTICAL;
  }

  /** アナログスティックからの丸め。x, y は -1..1。 */
  applyAnalog(x: number, y: number, deadzone = 0.35): number {
    let b = 0;
    if (this.ways === 4) {
      if (Math.abs(x) < deadzone && Math.abs(y) < deadzone) return 0;
      if (Math.abs(x) >= Math.abs(y)) b |= x > 0 ? BTN.RIGHT : BTN.LEFT;
      else b |= y > 0 ? BTN.DOWN : BTN.UP;
      return b;
    }
    if (x <= -deadzone) b |= BTN.LEFT;
    if (x >= deadzone) b |= BTN.RIGHT;
    if (y <= -deadzone) b |= BTN.UP;
    if (y >= deadzone) b |= BTN.DOWN;
    return b;
  }

  reset(): void {
    this.newer = null;
    this.prevV = false;
    this.prevH = false;
  }
}
