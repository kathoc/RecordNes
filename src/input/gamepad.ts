/** コントローラー。
 *
 *  Gamepad API はイベントを出さないので、**エミュレート直前にポーリングする**。
 *  読む場所がそのまま遅延になる。
 *
 *  L をコンビネーションキーにして、コントローラーだけで全機能へ届くようにする。
 *  L 単独では何も起きないので、誤爆しない。 */

import { BTN } from "../core/emu.ts";
import type { EdgeCommand, HeldCommand } from "./commands.ts";
import { DpadFilter } from "./dpad.ts";

/** 標準レイアウトのボタン番号。SNES 配置で読むと、
 *  0 = B(下), 1 = A(右), 2 = Y(左), 3 = X(上)。 */
export const PAD = {
  B: 0,
  A: 1,
  Y: 2,
  X: 3,
  L: 4,
  R: 5,
  L2: 6,
  R2: 7,
  SELECT: 8,
  START: 9,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

/** L を押しながらの割り当て。 */
export const L_COMBO: Record<number, EdgeCommand> = {
  [PAD.A]: "frameAdvance",
  [PAD.B]: "pauseToggle",
  [PAD.X]: "saveState",
  [PAD.Y]: "loadState",
  [PAD.START]: "reset",
  [PAD.SELECT]: "saveRecording",
  [PAD.R]: "marker",
  [PAD.UP]: "speedUp",
  [PAD.DOWN]: "speedDown",
};

export const L_COMBO_HELD: Record<number, HeldCommand> = {
  [PAD.LEFT]: "rewind",
  [PAD.RIGHT]: "fastForward",
};

/** 説明パネルに出す一覧。 */
export const L_COMBO_HELP: [string, string][] = [
  ["L + ←", "巻き戻し（押している間）"],
  ["L + →", "早送り（押している間）"],
  ["L + ↑ / ↓", "速度を上げる / 下げる"],
  ["L + A", "コマ送り"],
  ["L + B", "一時停止 / 再開"],
  ["L + X", "ステートセーブ"],
  ["L + Y", "ステートロード"],
  ["L + START", "リセット"],
  ["L + SELECT", "記録を保存"],
  ["L + R", "目印を打つ"],
];

export class Pad {
  dpad = new DpadFilter();
  /** つながっているか。UI の表示に使う */
  connected = false;
  /** この Pad が見る接続順。0 = 1P、1 = 2P */
  slot = 0;
  /** 最後に見たボタンの状態。立ち上がり検出用 */
  private prev: boolean[] = [];
  private pending: EdgeCommand[] = [];
  private heldNow = new Set<HeldCommand>();
  private padBitsNow = 0;
  private turboA = false;
  private turboB = false;
  /** L を押している間は、通常のボタンをゲームへ流さない */
  private comboActive = false;
  /** 直前のフレームで L が押されていたか */
  index = 0;

  /** エミュレート直前に 1 回だけ呼ぶ。
   *
   *  `slot` 番目につながっているパッドを見る。2 台目が挿さっていれば 2P になる。
   *  番号ではなく接続順で選ぶのは、OS 側の index が抜き差しで飛ぶため。 */
  poll(): void {
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    let gp: Gamepad | null = null;
    let seen = 0;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      if (seen++ === this.slot) { gp = p; break; }
    }
    this.connected = !!gp;
    this.padBitsNow = 0;
    this.turboA = false;
    this.turboB = false;
    this.heldNow.clear();
    if (!gp) {
      this.comboActive = false;
      this.prev = [];
      return;
    }
    this.index = gp.index;

    const pressed = (i: number): boolean => !!gp!.buttons[i]?.pressed;
    const combo = pressed(PAD.L) || pressed(PAD.L2);
    this.comboActive = combo;

    if (combo) {
      for (const [k, cmd] of Object.entries(L_COMBO_HELD)) {
        if (pressed(Number(k))) this.heldNow.add(cmd);
      }
      // 左スティックでも巻き戻し・早送りできるようにする。
      const ax = gp.axes[0] ?? 0;
      if (ax <= -0.5) this.heldNow.add("rewind");
      if (ax >= 0.5) this.heldNow.add("fastForward");
    } else {
      let bits = 0;
      if (pressed(PAD.UP)) bits |= BTN.UP;
      if (pressed(PAD.DOWN)) bits |= BTN.DOWN;
      if (pressed(PAD.LEFT)) bits |= BTN.LEFT;
      if (pressed(PAD.RIGHT)) bits |= BTN.RIGHT;
      if (pressed(PAD.A)) bits |= BTN.A;
      if (pressed(PAD.B)) bits |= BTN.B;
      if (pressed(PAD.START)) bits |= BTN.START;
      if (pressed(PAD.SELECT)) bits |= BTN.SELECT;
      bits = this.dpad.applyDigital(bits);
      if (bits === 0 || !(bits & (BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT))) {
        // 十字キーが無い(スティックのみの)パッドのために、左スティックも読む。
        bits |= this.dpad.applyAnalog(gp.axes[0] ?? 0, gp.axes[1] ?? 0);
      }
      this.padBitsNow = bits;
      this.turboA = pressed(PAD.X);
      this.turboB = pressed(PAD.Y);
    }

    // 立ち上がり。L の有無で行き先が変わる。
    for (let i = 0; i < gp.buttons.length; i++) {
      const now = pressed(i);
      const was = this.prev[i] ?? false;
      this.prev[i] = now;
      if (!now || was) continue;
      if (combo) {
        const cmd = L_COMBO[i];
        if (cmd) this.pending.push(cmd);
      }
    }
  }

  padBits(): number {
    return this.padBitsNow;
  }

  turboHeld(button: "A" | "B"): boolean {
    return button === "A" ? this.turboA : this.turboB;
  }

  heldCommands(): Set<HeldCommand> {
    return this.heldNow;
  }

  takeEdges(): EdgeCommand[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** L を押している最中か。HUD にヒントを出すのに使う */
  get comboHeld(): boolean {
    return this.comboActive;
  }

  anyPadDown(): boolean {
    return this.padBitsNow !== 0 || this.turboA || this.turboB;
  }
}
