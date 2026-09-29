/** エミュレーターと記録をつなぐ層。UI はここだけを叩く。
 *
 *  設計の中心にあるのは 1 つの規則。
 *
 *    **記録は常に走っていて、書き込む位置は「今いるフレーム」で決まる。**
 *
 *  巻き戻しは状態を戻すだけで、記録には手を触れない。戻った先で新しい入力を
 *  書き込もうとした瞬間に、はじめてタイムラインがそこで切られる。だから
 *  「巻き戻して、そのまま元の続きを早送りで見る」は記録を壊さないし、
 *  「巻き戻して、やり直す」は自動的に一本の記録につながる。 */

import { clearJam, consumeJam } from "./jam-watch.ts";
import { Emu } from "./emu.ts";
import type { RomInfo } from "./romid.ts";
import { Recorder } from "../record/recorder.ts";
import type { TimelineEvent } from "../record/types.ts";

export type Mode = "record" | "playback";

export interface SessionOptions {
  sampleRate?: number;
  /** リセットで記録を消すか。既定 true (消す)。false ならリセット自体を記録する */
  resetClearsRecording?: boolean;
  /** ラン・アヘッド段数 0〜3 */
  runAhead?: number;
}

export interface FrameStats {
  emuMs: number;
  runAheadMs: number;
  stateMs: number;
}

export class Session {
  emu: Emu;
  /** ラン・アヘッド専用の第 2 インスタンス。
   *
   *  同じインスタンスで「保存 → 先読み → 復元」をすると、コアの復元が完全ではなく
   *  音声の DC フィルタ(4 バイト)が残る。映像は 600 フレーム回しても一致するので
   *  実害は無いが、記録用の状態を汚さない作りにしておく方が後で困らない。
   *  先読みは映像を見せるためだけのものなので、別インスタンスに完全に閉じる。 */
  private ahead: Emu | null = null;
  rec: Recorder | null = null;
  mode: Mode = "record";
  resetClearsRecording = true;
  runAhead = 1;
  /** 再生中にコントローラーへ触れたら記録を引き継ぐ */
  takeoverOnInput = true;

  /** キーフレームの復元が壊れていたときに立つ。立っている間、UI は再計算中を出す */
  recovering = false;
  /** 復元に使ったキーフレームの位置。壊れていたらこれを捨てる */
  private lastRestoredFrame = -1;
  /** JAM を検知した地点。App が次の rAF で recover() を呼ぶ */
  pendingRecovery: number | null = null;

  /** 直近フレームで実際にエミュレーターへ入った入力。HUD 表示用 */
  lastInput: [number, number] = [0, 0];
  lastStats: FrameStats = { emuMs: 0, runAheadMs: 0, stateMs: 0 };

  private romBytes: Uint8Array | null = null;
  private romInfo: RomInfo | null = null;
  private sink: ((s: number) => void) | null = null;

  constructor(opts: SessionOptions = {}) {
    this.emu = new Emu(opts.sampleRate ?? 48000);
    this.resetClearsRecording = opts.resetClearsRecording ?? true;
    this.runAhead = opts.runAhead ?? 1;
  }

  get frame(): number {
    return this.emu.frameCount;
  }

  get totalFrames(): number {
    return this.rec?.frameCount ?? 0;
  }

  /** 記録の末尾にいるか。再生の終端判定に使う */
  get atTail(): boolean {
    return this.frame >= this.totalFrames;
  }

  setSink(sink: ((s: number) => void) | null): void {
    this.sink = sink;
  }

  /** 先読み側の絵が今のフレームのものか。巻き戻しや復元の直後は古い。 */
  private aheadFresh = false;

  /** 画面に出すべきピクセル。ラン・アヘッド中は「N フレーム先」の絵。
   *
   *  巻き戻しや位置移動のあとは先読みが追いついていないので、記録用の絵を出す。
   *  ここを見ずに常に先読み側を返すと、**巻き戻し中に画面が固まる**。 */
  get pixels(): Uint8Array {
    return this.runAhead > 0 && this.aheadFresh && this.ahead?.loaded
      ? this.ahead.pixels
      : this.emu.pixels;
  }

  private async ensureAhead(): Promise<void> {
    if (!this.romBytes) return;
    if (!this.ahead) this.ahead = new Emu(this.emu.sampleRate);
    await this.ahead.load(this.romBytes);
    this.ahead.setSink(null);
  }

  async loadRom(bytes: Uint8Array, info: RomInfo, title: string): Promise<void> {
    this.romBytes = bytes.slice();
    this.romInfo = info;
    await this.emu.load(this.romBytes);
    if (this.runAhead > 0) await this.ensureAhead();
    this.rec = new Recorder(info, title, "power");
    this.mode = "record";
    this.emu.setSink(this.sink);
    this.snapshotHere();
  }

  /** 記録ファイルを開く。ROM は呼び出し側が先に読み込んでおく。 */
  async adoptRecording(rec: Recorder, atFrame: number | "tail" = "tail"): Promise<void> {
    if (!this.romBytes) throw new Error("先に ROM を読み込んでください");
    this.rec = rec;
    await this.emu.load(this.romBytes);
    if (this.runAhead > 0) await this.ensureAhead();
    if (rec.originState) {
      this.emu.loadState(rec.originState);
    }
    this.emu.frameCount = 0;
    const target = atFrame === "tail" ? rec.frameCount : atFrame;
    if (!this.seek(target)) await this.recover();
  }

  /** 今の状態をキーフレームとして記録へ預ける。 */
  private snapshotHere(state?: Uint8Array): void {
    if (!this.rec) return;
    this.rec.snapshot(this.emu.frameCount, state ?? this.emu.saveState());
  }

  /** 1 フレーム進める。`live` は今ポーリングしたばかりの入力。 */
  step(live: [number, number]): void {
    if (!this.rec || !this.emu.loaded) return;
    const f = this.emu.frameCount;

    // 再生中に手が動いたら、そこで記録を引き継ぐ。
    if (this.mode === "playback" && this.takeoverOnInput && (live[0] !== 0 || live[1] !== 0)) {
      this.mode = "record";
    }

    let p1: number, p2: number;
    if (this.mode === "playback" && f < this.rec.frameCount) {
      [p1, p2] = this.rec.inputAt(f);
    } else {
      [p1, p2] = live;
    }

    // このフレームに紐づくイベント(リセット)を先に適用する。
    for (const e of this.rec.eventsAt(f)) {
      if (e.type === "reset") this.emu.reset();
    }

    const t0 = now();
    this.emu.setSink(this.sink);
    clearJam();
    this.emu.step(p1, p2);
    const t1 = now();

    // コアが「CPU が止まった」と言ってきたら、直前に復元したキーフレームを疑う。
    // 記録の正本は入力列なので、電源投入から流し直せば必ず戻れる。
    if (consumeJam()) {
      this.pendingRecovery = f;
      this.aheadFresh = false;
      return;
    }

    if (this.mode === "record") {
      // 戻った先で書こうとしている = 巻き戻し後の再開。ここでタイムラインを切る。
      if (f < this.rec.frameCount) this.rec.truncate(f);
      this.rec.push(p1, p2);
    }
    this.lastInput = [p1, p2];

    // 状態を 1 回だけ保存し、キーフレームとラン・アヘッドの両方に使う。
    const s0 = now();
    const state = this.emu.saveState();
    const stMs = now() - s0;

    // ラン・アヘッド: 第 2 インスタンスを今の状態に合わせ、同じ入力で先を計算する。
    // 見せるのはその最後の 1 枚。記録用インスタンスには指一本触れない。
    let raMs = 0;
    if (this.runAhead > 0 && this.ahead?.loaded) {
      const r0 = now();
      this.ahead.loadState(state);
      for (let i = 0; i < this.runAhead; i++) this.ahead.step(p1, p2);
      this.aheadFresh = true;
      // 先読み側が止まっても、記録用は無事。ここで旗を下ろして巻き込まない。
      consumeJam();
      raMs = now() - r0;
    }
    this.snapshotHere(state);
    this.lastStats = { emuMs: t1 - t0, runAheadMs: raMs, stateMs: stMs };
  }

  /** 巻き戻し。戻れなければ false。 */
  rewind(frames = 1): boolean {
    if (!this.rec) return false;
    const target = Math.max(0, this.emu.frameCount - frames);
    if (target === this.emu.frameCount) return false;
    return this.seek(target);
  }

  /** 任意のフレームへ飛ぶ。最寄りのキーフレームから入力を再実行して到達する。
   *
   *  キーフレームが使えないとき (記録を読み込んだ直後や、壊れた状態を捨てたあと) は
   *  電源投入から流し直す。遅いが、必ず正しい位置に着く。 */
  seek(target: number): boolean {
    if (!this.rec) return false;
    const goal = Math.max(0, Math.min(target, this.rec.frameCount));
    // **1 つ手前の地点から入り直す。**
    //
    // 状態を復元しただけでは絵が描かれない。コアが描くのは 1 フレーム実行したとき
    // だけで、復元は画面に触らないからだ。目的のフレームちょうどのキーフレームへ
    // 飛ぶと 1 フレームも走らず、前に映っていた絵が残る。記録を読み込んだ直後が
    // 真っ黒になり、巻き戻し中は 1 フレーム古い絵が出る。
    // 1 つ手前から入れば必ず 1 フレームは走るので、必ず今の絵になる。
    const k = this.rec.nearestState(Math.max(0, goal - 1));
    if (!k) {
      // 同期では電源投入に戻せない。呼び出し側へ再計算を頼む。
      this.pendingRecovery = goal;
      return false;
    }
    this.emu.loadState(k.state);
    this.emu.frameCount = k.frame;
    this.lastRestoredFrame = k.frame;
    this.aheadFresh = false;
    clearJam();
    this.replayTo(goal);
    // 復元したキーフレームが壊れていれば、ここで CPU が止まる。
    if (consumeJam()) {
      this.pendingRecovery = goal;
      return false;
    }
    this.snapshotHere();
    return true;
  }

  /** 今の位置から goal まで、記録された入力で無音のまま進める。 */
  private replayTo(goal: number): void {
    if (!this.rec) return;
    this.aheadFresh = false;
    this.emu.setSink(null);
    while (this.emu.frameCount < goal) {
      const f = this.emu.frameCount;
      for (const e of this.rec.eventsAt(f)) if (e.type === "reset") this.emu.reset();
      const [a, b] = this.rec.inputAt(f);
      this.emu.step(a, b);
    }
    this.emu.setSink(this.sink);
  }

  /** 壊れた状態から立て直す。電源投入から入力列を流し直して目的のフレームへ戻る。 */
  async recover(): Promise<void> {
    const goal = this.pendingRecovery;
    this.pendingRecovery = null;
    if (goal === null || !this.rec || !this.romBytes) return;
    this.recovering = true;
    try {
      // 元凶のキーフレームを二度と使わないよう捨てる。
      if (this.lastRestoredFrame >= 0) this.rec.poison(this.lastRestoredFrame);
      this.lastRestoredFrame = -1;
      await this.emu.load(this.romBytes);
      if (this.rec.originState) this.emu.loadState(this.rec.originState);
      this.emu.frameCount = 0;
      this.aheadFresh = false;
      clearJam();
      this.replayTo(goal);
      this.snapshotHere();
    } finally {
      this.recovering = false;
    }
  }

  /** リセット。設定により、記録を消すか、リセット自体を記録するかが変わる。 */
  async reset(): Promise<void> {
    if (!this.rec || !this.romBytes || !this.romInfo) return;
    if (this.resetClearsRecording) {
      await this.emu.load(this.romBytes);
      if (this.runAhead > 0) await this.ensureAhead();
      this.rec = new Recorder(this.romInfo, this.rec.title, "power");
      this.mode = "record";
      this.snapshotHere();
      return;
    }
    // 記録を続ける場合。現在位置より先は捨て、リセットをイベントとして刻む。
    const f = this.emu.frameCount;
    if (f < this.rec.frameCount) this.rec.truncate(f);
    this.rec.addEvent("reset", f);
    this.emu.reset();
    this.mode = "record";
    this.snapshotHere();
  }

  /** 再生を始める。記録の先頭から観る。 */
  playFromStart(): void {
    if (!this.rec) return;
    this.mode = "playback";
    this.seek(0);
  }

  playFrom(frame: number): void {
    if (!this.rec) return;
    this.mode = "playback";
    this.seek(frame);
  }

  /** 引き継ぎ。再生を止めて、今いるフレームから自分で続ける。 */
  takeover(): void {
    this.mode = "record";
  }

  /** ラン・アヘッド段数を変える。0 にすると第 2 インスタンスは眠る。 */
  async setRunAhead(n: number): Promise<void> {
    this.runAhead = Math.max(0, Math.min(3, n | 0));
    if (this.runAhead > 0 && !this.ahead?.loaded) await this.ensureAhead();
  }

  mark(label?: string): void {
    this.rec?.addEvent("marker", this.emu.frameCount, label);
  }

  markers(): TimelineEvent[] {
    return this.rec?.events.filter((e) => e.type === "marker") ?? [];
  }

  romData(): Uint8Array | null {
    return this.romBytes;
  }
}

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();
