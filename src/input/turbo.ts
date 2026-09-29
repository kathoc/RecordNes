/** 連射。
 *
 *  **位相は実時間ではなくフレーム番号で決める。** スロー・早送り・コマ送りの
 *  どれを使っていても、記録に入る連射の形が変わらないようにするため。実時間の
 *  `setInterval` で作ると、1/8 速で動かした瞬間に連射が 8 倍細かくなってしまう。 */

export type TurboMode = "off" | "hold" | "toggle";

export const TURBO_MODES: TurboMode[] = ["off", "hold", "toggle"];

export const TURBO_LABEL: Record<TurboMode, string> = {
  off: "連射 OFF",
  hold: "連射 ホールド",
  toggle: "連射 トグル",
};

export const TURBO_HELP: Record<TurboMode, string> = {
  off: "連射しません",
  hold: "押している間だけ連射。押した瞬間は単発で入り、0.5 秒後から連射に移ります",
  toggle: "一度押すと離しても連射が続きます。もう一度押すと止まります",
};

/** ホールド連射で、押してから連射が始まるまでのフレーム数 (0.5 秒)。 */
export const HOLD_DELAY_FRAMES = 30;

export interface TurboState {
  mode: TurboMode;
  /** 連射速度 (Hz)。5〜30 */
  rate: number;
}

interface Track {
  /** 押し始めたフレーム。離していれば -1 */
  since: number;
  /** トグル連射で掛かっているか */
  latched: boolean;
  /** 直前のフレームで押されていたか。立ち上がり検出用 */
  prev: boolean;
}

/** A と B それぞれについて、連射ボタンの状態から「このフレームで押すか」を決める。 */
export class Turbo {
  state: TurboState = { mode: "hold", rate: 15 };
  private tracks: Record<"A" | "B", Track> = {
    A: { since: -1, latched: false, prev: false },
    B: { since: -1, latched: false, prev: false },
  };

  setMode(mode: TurboMode): void {
    this.state.mode = mode;
    if (mode !== "toggle") for (const k of ["A", "B"] as const) this.tracks[k].latched = false;
  }

  /** スイッチを 1 段送る。OFF → ホールド → トグル → OFF */
  cycleMode(): TurboMode {
    const i = TURBO_MODES.indexOf(this.state.mode);
    this.setMode(TURBO_MODES[(i + 1) % TURBO_MODES.length]);
    return this.state.mode;
  }

  setRate(hz: number): void {
    this.state.rate = Math.max(5, Math.min(30, Math.round(hz)));
  }

  /** ON と OFF を切り替える間隔(フレーム)。15Hz なら 2。 */
  private halfPeriod(): number {
    return Math.max(1, Math.round(60 / (this.state.rate * 2)));
  }

  reset(): void {
    for (const k of ["A", "B"] as const) this.tracks[k] = { since: -1, latched: false, prev: false };
  }

  /**
   * @param button  どちらのボタンの連射か
   * @param held    連射ボタン(パッドの X / Y、キーボードの S / A)が押されているか
   * @param frame   今から進めるフレーム番号。位相の基準
   * @returns このフレームでそのボタンを押すか
   */
  tick(button: "A" | "B", held: boolean, frame: number): boolean {
    const t = this.tracks[button];
    const rising = held && !t.prev;
    t.prev = held;

    if (this.state.mode === "off") {
      // 連射 OFF なら、連射ボタンは普通の A / B として働く。押した分だけ入る。
      t.since = held ? (t.since < 0 ? frame : t.since) : -1;
      return held;
    }

    if (this.state.mode === "toggle") {
      if (rising) {
        t.latched = !t.latched;
        t.since = t.latched ? frame : -1;
      }
      if (!t.latched) return false;
      return this.phase(frame - t.since);
    }

    // ホールド連射
    if (!held) {
      t.since = -1;
      return false;
    }
    if (t.since < 0) t.since = frame;
    const elapsed = frame - t.since;
    if (elapsed < HOLD_DELAY_FRAMES) return true; // 最初の 0.5 秒は押しっぱなし
    return this.phase(elapsed - HOLD_DELAY_FRAMES);
  }

  private phase(elapsed: number): boolean {
    return Math.floor(elapsed / this.halfPeriod()) % 2 === 0;
  }

  /** トグル連射が掛かっているか。HUD 表示用。 */
  latched(button: "A" | "B"): boolean {
    return this.state.mode === "toggle" && this.tracks[button].latched;
  }
}
