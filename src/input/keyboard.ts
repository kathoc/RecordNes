/** キーボード。
 *
 *  **イベントではビットを立てるだけで、読むのはエミュレート直前。**
 *  イベント受信時に「このフレームの入力」を確定させてしまうと、確定から実行までの
 *  間隔がそのまま遅延になる。押下の記録と採取を分けるのが、遅延を増やさない形。 */

import { BTN } from "../core/emu.ts";
import type { EdgeCommand, HeldCommand } from "./commands.ts";

export interface KeyBindings {
  /** キーコード -> NES ボタン名 */
  pad: Record<string, keyof typeof BTN>;
  /** キーコード -> 連射ボタン ("turboA" / "turboB") */
  turbo: Record<string, "A" | "B">;
  /** キーコード -> 押し続ける操作 */
  held: Record<string, HeldCommand>;
  /** キーコード -> 一度きりの操作 */
  edge: Record<string, EdgeCommand>;
}

export const DEFAULT_BINDINGS: KeyBindings = {
  pad: {
    ArrowUp: "UP",
    ArrowDown: "DOWN",
    ArrowLeft: "LEFT",
    ArrowRight: "RIGHT",
    KeyZ: "B",
    KeyX: "A",
    Enter: "START",
    ShiftRight: "SELECT",
  },
  turbo: { KeyA: "B", KeyS: "A" },
  held: { Backspace: "rewind", Tab: "fastForward" },
  edge: {
    KeyF: "frameAdvance",
    Space: "pauseToggle",
    BracketRight: "speedUp",
    BracketLeft: "speedDown",
    F1: "saveState",
    F2: "loadState",
    F3: "saveStateFile",
    F4: "loadStateFile",
    F5: "saveRecording",
    KeyM: "marker",
    KeyT: "turboCycle",
    KeyW: "waysToggle",
    KeyP: "playFromStart",
  },
};

export class Keyboard {
  bindings: KeyBindings = structuredClone(DEFAULT_BINDINGS);
  /** 押されているキーコード */
  private down = new Set<string>();
  /** まだ読み取られていない立ち上がり */
  private pending: EdgeCommand[] = [];
  /** 最後にキーイベントを受けた時刻。遅延の計測に使う */
  lastEventAt = 0;
  /** リセットは Ctrl+R。単独の R は目印と紛れるので使わない */
  private wantReset = false;

  attach(target: EventTarget = window): () => void {
    const onDown = (ev: Event): void => {
      const e = ev as KeyboardEvent;
      if (e.repeat) {
        // コマ送りだけは押しっぱなしで連続させたい。
        if (this.bindings.edge[e.code] === "frameAdvance") this.pending.push("frameAdvance");
        e.preventDefault();
        return;
      }
      this.lastEventAt = performance.now();
      if (e.ctrlKey && e.code === "KeyR") {
        this.wantReset = true;
        e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.known(e.code)) e.preventDefault();
      if (this.down.has(e.code)) return;
      this.down.add(e.code);
      const cmd = this.bindings.edge[e.code];
      if (cmd) this.pending.push(cmd);
    };
    const onUp = (ev: Event): void => {
      const e = ev as KeyboardEvent;
      this.down.delete(e.code);
      if (this.known(e.code)) e.preventDefault();
    };
    const onBlur = (): void => this.down.clear();
    target.addEventListener("keydown", onDown);
    target.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      target.removeEventListener("keydown", onDown);
      target.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }

  private known(code: string): boolean {
    const b = this.bindings;
    return code in b.pad || code in b.turbo || code in b.held || code in b.edge;
  }

  /** 十字キーと A / B。連射ボタンは別に返す。 */
  padBits(): number {
    let bits = 0;
    for (const [code, name] of Object.entries(this.bindings.pad)) {
      if (this.down.has(code)) bits |= BTN[name];
    }
    return bits;
  }

  turboHeld(button: "A" | "B"): boolean {
    for (const [code, b] of Object.entries(this.bindings.turbo)) {
      if (b === button && this.down.has(code)) return true;
    }
    return false;
  }

  heldCommands(): Set<HeldCommand> {
    const out = new Set<HeldCommand>();
    for (const [code, cmd] of Object.entries(this.bindings.held)) {
      if (this.down.has(code)) out.add(cmd);
    }
    return out;
  }

  /** 立ち上がりを取り出して空にする。 */
  takeEdges(): EdgeCommand[] {
    const out = this.pending;
    this.pending = [];
    if (this.wantReset) {
      out.push("reset");
      this.wantReset = false;
    }
    return out;
  }

  anyPadDown(): boolean {
    return this.padBits() !== 0 || this.turboHeld("A") || this.turboHeld("B");
  }
}
