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
  /** 1P のコントローラー。L コンビネーションはここから出る */
  pad = new Pad();
  /** 2P のコントローラー。2 台目が挿さっていれば働く */
  pad2 = new Pad();
  turbo = new Turbo();
  /** 2P 用の連射。位相を 1P と分ける */
  turbo2 = new Turbo();
  /** キーボード側の十字キーにも同じ丸めをかける */
  keyDpad = new DpadFilter();

  /** キー入力が来てからエミュレートするまでの実時間 (ms)。0 に近いほどよい */
  lastInputLatencyMs = 0;

  attach(): () => void {
    return this.keyboard.attach();
  }

  constructor() {
    this.pad2.slot = 1;
  }

  setWays(w: Ways): void {
    this.pad.dpad.setWays(w);
    this.pad2.dpad.setWays(w);
    this.keyDpad.setWays(w);
  }

  /** 2P がつながっているか。UI の表示に使う */
  get twoPlayers(): boolean {
    return this.pad2.connected;
  }

  get ways(): Ways {
    return this.keyDpad.ways;
  }

  /** エミュレート直前に呼ぶ。`frame` は今から進めるフレーム番号。 */
  sample(frame: number): InputSnapshot {
    this.pad.poll();
    this.pad2.poll();
    const now = performance.now();
    if (this.keyboard.lastEventAt > 0) {
      this.lastInputLatencyMs = now - this.keyboard.lastEventAt;
    }

    let bits = this.keyDpad.applyDigital(this.keyboard.padBits()) | this.pad.padBits();

    const turboAHeld = this.keyboard.turboHeld("A") || this.pad.turboHeld("A");
    const turboBHeld = this.keyboard.turboHeld("B") || this.pad.turboHeld("B");
    if (this.turbo.tick("A", turboAHeld, frame)) bits |= BTN.A;
    if (this.turbo.tick("B", turboBHeld, frame)) bits |= BTN.B;

    // 2P。連射の設定は 1P と共通だが、位相は別に進める。
    let bits2 = this.pad2.padBits();
    if (this.turbo2.state.mode !== this.turbo.state.mode) this.turbo2.setMode(this.turbo.state.mode);
    this.turbo2.setRate(this.turbo.state.rate);
    if (this.turbo2.tick("A", this.pad2.turboHeld("A"), frame)) bits2 |= BTN.A;
    if (this.turbo2.tick("B", this.pad2.turboHeld("B"), frame)) bits2 |= BTN.B;

    // 機能の操作はどちらのパッドからでも出せる。
    const held = new Set<HeldCommand>([
      ...this.keyboard.heldCommands(),
      ...this.pad.heldCommands(),
      ...this.pad2.heldCommands(),
    ]);
    const edges: EdgeCommand[] = [
      ...this.keyboard.takeEdges(),
      ...this.pad.takeEdges(),
      ...this.pad2.takeEdges(),
    ];

    return {
      pads: [bits & 0xff, bits2 & 0xff],
      held,
      edges,
      touched: this.keyboard.anyPadDown() || this.pad.anyPadDown() || this.pad2.anyPadDown(),
    };
  }

  /** ROM を替えたときなど、握りっぱなしの状態を捨てる。 */
  reset(): void {
    this.turbo.reset();
    this.turbo2.reset();
    this.keyDpad.reset();
    this.pad.dpad.reset();
    this.pad2.dpad.reset();
  }
}
