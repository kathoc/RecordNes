/** キーボードとコントローラーをまとめ、1 フレーム分の入力を作る。
 *
 *  **`sample()` はエミュレート直前に 1 回だけ呼ぶ。** ここで初めて
 *  「このフレームの入力」が決まるので、ここより手前で確定させてはいけない。 */

import { BTN } from "../core/emu.ts";
import type { EdgeCommand, HeldCommand, InputSnapshot } from "./commands.ts";
import { Keyboard } from "./keyboard.ts";
import { Pad } from "./gamepad.ts";
import { Turbo } from "./turbo.ts";
import { DpadFilter, type Ways } from "./dpad.ts";

export class InputManager {
  keyboard = new Keyboard();
  pad = new Pad();
  turbo = new Turbo();
  /** キーボード側の十字キーにも同じ丸めをかける */
  keyDpad = new DpadFilter();

  /** キー入力が来てからエミュレートするまでの実時間 (ms)。0 に近いほどよい */
  lastInputLatencyMs = 0;

  attach(): () => void {
    return this.keyboard.attach();
  }

  setWays(w: Ways): void {
    this.pad.dpad.setWays(w);
    this.keyDpad.setWays(w);
  }

  get ways(): Ways {
    return this.keyDpad.ways;
  }

  /** エミュレート直前に呼ぶ。`frame` は今から進めるフレーム番号。 */
  sample(frame: number): InputSnapshot {
    this.pad.poll();
    const now = performance.now();
    if (this.keyboard.lastEventAt > 0) {
      this.lastInputLatencyMs = now - this.keyboard.lastEventAt;
    }

    let bits = this.keyDpad.applyDigital(this.keyboard.padBits()) | this.pad.padBits();

    const turboAHeld = this.keyboard.turboHeld("A") || this.pad.turboHeld("A");
    const turboBHeld = this.keyboard.turboHeld("B") || this.pad.turboHeld("B");
    if (this.turbo.tick("A", turboAHeld, frame)) bits |= BTN.A;
    if (this.turbo.tick("B", turboBHeld, frame)) bits |= BTN.B;

    const held = new Set<HeldCommand>([
      ...this.keyboard.heldCommands(),
      ...this.pad.heldCommands(),
    ]);
    const edges: EdgeCommand[] = [...this.keyboard.takeEdges(), ...this.pad.takeEdges()];

    return {
      pads: [bits & 0xff, 0],
      held,
      edges,
      touched: this.keyboard.anyPadDown() || this.pad.anyPadDown(),
    };
  }

  /** ROM を替えたときなど、握りっぱなしの状態を捨てる。 */
  reset(): void {
    this.turbo.reset();
    this.keyDpad.reset();
    this.pad.dpad.reset();
  }
}
