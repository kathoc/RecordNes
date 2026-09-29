/** 画面と主ループ。
 *
 *  ループの形が遅延を決めるので、そこだけ先に説明しておく。
 *
 *    requestAnimationFrame の中で「入力を採る → エミュレートする → 描く」を閉じる。
 *
 *  どれか 1 つでも次の rAF へまたぐと、そこで 1 フレーム遅れる。入力を採るのは
 *  エミュレートの直前ただ 1 か所で、イベント受信時ではない。 */

import { SCREEN_H, SCREEN_W, describeInput } from "../core/emu.ts";
import { Session } from "../core/session.ts";
import { identifyRom, displayTitle } from "../core/romid.ts";
import type { RomInfo } from "../core/romid.ts";
import { parseToRecorder, serialize, suggestFileName } from "../record/format.ts";
import { Recorder } from "../record/recorder.ts";
import { InputManager } from "../input/manager.ts";
import { TURBO_HELP, TURBO_LABEL } from "../input/turbo.ts";
import { L_COMBO_HELP } from "../input/gamepad.ts";
import { DEFAULT_BINDINGS } from "../input/keyboard.ts";
import type { EdgeCommand, InputSnapshot } from "../input/commands.ts";
import { AudioOut } from "./audio.ts";
import type { PlatformBridge } from "../platform/types.ts";
import { DEFAULT_EXPORT, Exporter, type ExportSettings } from "../export/exporter.ts";
import type { Ways } from "../input/dpad.ts";

/** NES の実フレームレート。音声サンプル数から実測した値 (tools/audio-rate-probe.mjs)。 */
export const NES_FPS = 60.0978;
const FRAME_MS = 1000 / NES_FPS;

const SPEEDS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8];
const SPEED_LABEL = ["1/16", "1/8", "1/4", "1/2", "1x", "2x", "4x", "8x"];
const NORMAL_SPEED = 4;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface Settings {
  resetKeepsRecording: boolean;
  confirmDiscard: boolean;
  runAhead: number;
  turboRate: number;
  turboMode: "off" | "hold" | "toggle";
  rewindSpeed: number;
  uncapFrameRate: boolean;
  showPerf: boolean;
  volume: number;
  ways: Record<string, Ways>;
  exportSettings: ExportSettings;
}

const DEFAULT_SETTINGS: Settings = {
  resetKeepsRecording: false,
  confirmDiscard: true,
  runAhead: 1,
  turboRate: 15,
  turboMode: "off",
  rewindSpeed: 2,
  uncapFrameRate: false,
  showPerf: false,
  volume: 0.7,
  ways: {},
  exportSettings: { ...DEFAULT_EXPORT },
};

export class App {
  /** 自動検証から書き出しを回すために公開している。 */
  readonly bridge: PlatformBridge;
  private session = new Session({ runAhead: 1 });
  private input = new InputManager();
  private audio = new AudioOut();
  private settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private exporter = new Exporter();

  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private image!: ImageData;
  private tl!: HTMLCanvasElement;
  private tlCtx!: CanvasRenderingContext2D;

  private romInfo: RomInfo | null = null;

  private paused = false;
  private speedIndex = NORMAL_SPEED;
  private acc = 0;
  private lastTs = 0;
  private stepOnce = 0;
  /** 巻き戻し直後の案内を出すか */
  private rewindHint = false;
  /** 画面を描き直す必要があるか。vsync 制限を外すと rAF が数百 Hz で回るので、
   *  何も変わっていないフレームまで描くと CPU を無駄に食う。 */
  private dirty = true;
  private lastStatusAt = 0;
  /** 覚えた位置。ステートセーブの代わりに、タイムライン上の地点を覚える。
   *  状態そのものを抱えるより軽く、記録との食い違いも起きない。 */
  private marked: { frame: number; generation: number } | null = null;
  /** 最後に保存したときのフレーム数。これと違えば「まだ保存していない」 */
  savedAtFrames = -1;
  /** 閉じてよいと判断したあと。二度目の確認を出さない */
  private allowClose = false;
  private busy = false;
  /** 直近の rAF で使った実時間の内訳。計測表示用 */
  private perf = { emu: 0, raf: 0, latency: 0 };

  constructor(bridge: PlatformBridge) {
    this.bridge = bridge;
  }

  async start(): Promise<void> {
    this.canvas = $("screen");
    const ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) throw new Error("キャンバスを用意できませんでした");
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
    this.image = this.ctx.createImageData(SCREEN_W, SCREEN_H);
    this.tl = $("timeline");
    this.tlCtx = this.tl.getContext("2d")!;

    await this.loadSettings();
    this.input.attach();
    this.session.setSink(this.audio.push);
    this.wire();
    this.buildHelp();
    this.syncControls();
    void this.showEnvironment();

    requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- 設定

  private async loadSettings(): Promise<void> {
    const saved = await this.bridge.loadSettings();
    this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(saved as Partial<Settings>) };
    this.settings.exportSettings = { ...DEFAULT_EXPORT, ...(this.settings.exportSettings ?? {}) };
    this.settings.ways ??= {};
    this.session.resetClearsRecording = !this.settings.resetKeepsRecording;
    void this.session.setRunAhead(this.settings.runAhead);
    this.input.turbo.setRate(this.settings.turboRate);
    this.input.turbo.setMode(this.settings.turboMode);
    this.audio.setVolume(this.settings.volume);
  }

  private saveSettings(): void {
    void this.bridge.saveSettings(this.settings as unknown as Record<string, unknown>);
  }

  // ---------------------------------------------------------------- 主ループ

  private loop = (ts: number): void => {
    requestAnimationFrame(this.loop);
    const dt = this.lastTs ? Math.min(ts - this.lastTs, 250) : FRAME_MS;
    this.lastTs = ts;
    this.perf.raf = dt;

    if (this.busy) return;

    // 壊れたキーフレームを掴んだあとの立て直し。入力列から作り直すので時間がかかる。
    if (this.session.pendingRecovery !== null) {
      this.busy = true;
      const at = this.session.pendingRecovery;
      this.toast("状態の復元に失敗したので、記録から作り直しています…", "warn");
      void this.session.recover().then(() => {
        this.busy = false;
        this.lastTs = 0;
        this.toast(`${formatTime(at)} まで作り直しました`, "ok");
      });
      return;
    }

    // 入力の採取はここ 1 か所だけ。これより前で確定させない。
    const snap = this.input.sample(this.session.frame);
    this.applyEdges(snap.edges);
    this.perf.latency = this.input.lastInputLatencyMs;

    const t0 = performance.now();
    if (this.session.rec && this.romInfo) {
      if (snap.held.has("rewind")) {
        this.doRewind(dt);
      } else {
        this.runFrames(dt, snap);
      }
    }
    this.perf.emu = performance.now() - t0;

    // 進んでいないフレームまで描き直さない。
    if (this.dirty) {
      this.render();
      this.dirty = false;
    }
    // 文字とタイムラインは目で追える速さで十分。1 秒に 20 回まで。
    if (ts - this.lastStatusAt > 50) {
      this.lastStatusAt = ts;
      this.drawTimeline();
      this.updateStatus();
      // ボタンの見た目は毎回作り直す。状態を 2 か所に持つと必ずずれる。
      this.syncControls();
    }
  };

  /** この rAF で何フレーム進めるかを決めて、進める。 */
  private runFrames(dt: number, first: InputSnapshot): void {
    const fastForward = first.held.has("fastForward");
    const speed = fastForward ? Math.max(4, SPEEDS[this.speedIndex] * 4) : SPEEDS[this.speedIndex];
    const realtime = !fastForward && speed <= 1;

    let n = 0;
    if (this.paused) {
      n = this.stepOnce > 0 ? 1 : 0;
      if (n) this.stepOnce--;
    } else {
      this.acc += dt;
      const per = FRAME_MS / speed;
      n = Math.floor(this.acc / per);
      this.acc -= n * per;
      // 詰まったときに雪だるま式に増えないよう上限を置く。
      n = Math.min(n, speed <= 1 ? 2 : Math.ceil(speed) + 2);
    }
    if (n === 0) {
      if (realtime) this.audio.flush();
      return;
    }

    for (let i = 0; i < n; i++) {
      // 2 フレーム目以降も、そのフレームの入力を採り直す。連射の位相が正しくなる。
      const snap = i === 0 ? first : this.input.sample(this.session.frame);
      if (i > 0) this.applyEdges(snap.edges);
      const wasPlayback = this.session.mode === "playback";
      this.session.step(snap.pads);
      this.dirty = true;
      // 2 台目が挿さっていたら、記録にも 2 人分として残す。
      if (this.input.twoPlayers && this.session.rec) this.session.rec.players = 2;
      if (wasPlayback && this.session.mode === "record") {
        this.rewindHint = false;
        this.toast("ここから自分のプレイを記録します");
      }
      if (wasPlayback && this.session.atTail) {
        this.session.mode = "record";
        this.toast("記録の末尾に着きました。ここから続きを記録します");
      }
    }

    if (realtime) this.audio.flush();
    else this.audio.drop();
  }

  /** 巻き戻し。**戻す量は実時間から決める。**
   *
   *  rAF の回数で数えると、vsync 制限を外した環境で桁違いに速く戻ってしまう。
   *  実測: Xvfb 上で 1.2 秒押しただけで 374 フレームから 6 フレームまで戻った。 */
  private doRewind(dt: number): void {
    const speed = this.settings.rewindSpeed * Math.max(1, SPEEDS[this.speedIndex]);
    this.acc += dt * speed;
    const n = Math.floor(this.acc / FRAME_MS);
    if (n <= 0) return;
    this.acc -= n * FRAME_MS;
    this.audio.drop();

    // 巻き戻したら再生モードへ移る。こうしておくと、記録はまだ縮まない。
    // ボタンに触れた瞬間に引き継ぎが起きて、そこでタイムラインがつながる。
    if (this.session.mode === "record") {
      this.session.mode = "playback";
      this.rewindHint = true;
    }
    if (!this.session.rewind(Math.min(n, 240)) && this.session.pendingRecovery === null) {
      this.toast("これ以上は戻れません");
    }
    this.dirty = true;
  }

  // ---------------------------------------------------------------- 操作

  private applyEdges(edges: EdgeCommand[]): void {
    for (const cmd of edges) {
      switch (cmd) {
        case "pauseToggle": this.setPaused(!this.paused); break;
        case "frameAdvance":
          if (!this.paused) this.setPaused(true);
          this.stepOnce++;
          break;
        case "speedUp": this.setSpeed(this.speedIndex + 1); break;
        case "speedDown": this.setSpeed(this.speedIndex - 1); break;
        case "saveState": this.rememberSpot(); break;
        case "loadState": this.returnToSpot(); break;
        case "saveStateFile": void this.saveStateFile(); break;
        case "loadStateFile": void this.loadStateFile(); break;
        case "reset": void this.doReset(); break;
        case "saveRecording": void this.saveRecording(); break;
        case "marker": this.addMarker(); break;
        case "turboCycle": this.cycleTurbo(); break;
        case "waysToggle": this.toggleWays(); break;
        case "playFromStart": this.playFromStart(); break;
        case "takeover": this.session.takeover(); break;
      }
    }
  }

  private setPaused(v: boolean): void {
    this.paused = v;
    this.acc = 0;
    this.dirty = true;
    if (v) this.audio.drop();
  }

  private setSpeed(i: number): void {
    this.speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, i));
    this.acc = 0;
    this.toast(`速度 ${SPEED_LABEL[this.speedIndex]}`);
  }

  private cycleTurbo(): void {
    const mode = this.input.turbo.cycleMode();
    this.settings.turboMode = mode;
    this.saveSettings();
    this.syncControls();
    this.toast(TURBO_LABEL[mode]);
  }

  private toggleWays(): void {
    const next: Ways = this.input.ways === 8 ? 4 : 8;
    this.input.setWays(next);
    if (this.romInfo) {
      this.settings.ways[this.romInfo.sha1] = next;
      this.saveSettings();
    }
    this.syncControls();
    this.toast(next === 4 ? "4-WAY: 斜めを出しません" : "8-WAY: 斜めを出します");
  }

  /** 今いる地点を覚える。ステートセーブに当たる操作。 */
  private rememberSpot(): void {
    if (!this.session.rec) return;
    this.marked = { frame: this.session.frame, generation: this.session.rec.rewinds };
    this.toast(`${formatTime(this.marked.frame)} を覚えました（戻るときは ${this.keyFor("loadState")}）`, "ok");
  }

  /** 覚えた地点へ戻る。巻き戻しと同じ扱いなので、記録はまだ縮まない。 */
  private returnToSpot(): void {
    if (!this.session.rec) return;
    if (!this.marked) {
      this.toast("まだどこも覚えていません", "warn");
      return;
    }
    if (this.marked.frame > this.session.totalFrames) {
      this.toast("覚えた地点は、やり直しで消えました", "warn");
      this.marked = null;
      return;
    }
    this.session.mode = "playback";
    this.rewindHint = true;
    this.session.seek(this.marked.frame);
    this.audio.clear();
    this.dirty = true;
    this.toast(`${formatTime(this.marked.frame)} へ戻りました`);
  }

  /** その操作に割り当てられているキー。案内文に差し込む。 */
  private keyFor(cmd: EdgeCommand): string {
    const entry = Object.entries(this.input.keyboard.bindings.edge).find(([, v]) => v === cmd);
    return entry ? entry[0].replace(/^Key|^Digit/, "") : "?";
  }

  private addMarker(): void {
    if (!this.session.rec) return;
    this.session.mark();
    this.toast(`目印: ${formatTime(this.session.frame)}`);
  }

  private playFromStart(): void {
    if (!this.session.rec || this.session.totalFrames === 0) return;
    this.session.playFromStart();
    this.setPaused(false);
    this.setSpeed(NORMAL_SPEED);
    this.audio.clear();
    this.toast("最初から再生します");
  }

  private async doReset(): Promise<void> {
    if (!this.session.rec) return;
    if (this.session.resetClearsRecording && this.settings.confirmDiscard && this.session.totalFrames > 60) {
      if (!confirm(`リセットすると、ここまでの記録 (${formatTime(this.session.totalFrames)}) が消えます。よろしいですか？\n\n設定で「リセットで記録を消さない」を有効にすると、リセットそのものを記録に残せます。`)) return;
    }
    await this.session.reset();
    this.audio.clear();
    this.setPaused(false);
    this.toast(this.session.resetClearsRecording ? "リセットしました（記録は消えました）" : "リセットを記録しました");
  }

  // ---------------------------------------------------------------- ファイル

  /** 音声を起こす。出力先が無い環境 (CI や Xvfb) でも、ここで止まらないようにする。 */
  private async startAudio(): Promise<void> {
    try {
      await this.audio.start();
      // 出口のレートに合わせる。ROM を読み込む前でないと作り直せない。
      this.session.setSampleRate(this.audio.sampleRate);
      this.session.setSink(this.audio.push);
    } catch (err) {
      console.warn("音声を初期化できませんでした。無音で続けます:", err);
      this.session.setSink(null);
    }
  }

  private async openRom(): Promise<void> {
    const f = await this.bridge.openFile("rom");
    if (f) await this.loadRomBytes(f.bytes, f.name);
  }

  async loadRomBytes(bytes: Uint8Array, name: string): Promise<void> {
    if (this.session.rec && this.session.totalFrames > 60 && this.settings.confirmDiscard) {
      if (!confirm(`別の ROM を読み込むと、ここまでの記録 (${formatTime(this.session.totalFrames)}) が消えます。よろしいですか？`)) return;
    }
    let info: RomInfo;
    try {
      info = await identifyRom(bytes, name);
    } catch (err) {
      this.toast((err as Error).message, "warn");
      return;
    }
    this.busy = true;
    try {
      await this.startAudio();
      await this.session.loadRom(bytes, info, displayTitle(name));
      this.romInfo = info;
      this.savedAtFrames = -1;
      this.input.reset();
      this.input.setWays(this.settings.ways[info.sha1] ?? 8);
      this.audio.clear();
      this.setPaused(false);
      this.setSpeed(NORMAL_SPEED);
      $("rom-name").textContent = `${displayTitle(name)}  (マッパー ${info.mapper})`;
      $("drop-hint").classList.add("hide");
      for (const id of ["btn-save-rec", "btn-export"]) ($(id) as HTMLButtonElement).disabled = false;
      this.syncControls();
      this.toast("記録を開始しました。保存は「記録を保存」から", "ok");
    } catch (err) {
      this.toast(`ROM を読み込めませんでした: ${(err as Error).message}`, "warn");
    } finally {
      this.busy = false;
    }
  }

  private async saveRecording(): Promise<boolean> {
    if (!this.session.rec || this.session.totalFrames === 0) {
      this.toast("まだ記録がありません", "warn");
      return false;
    }
    this.busy = true;
    try {
      const bytes = await serialize(this.session.rec, this.session.emu.sram());
      const path = await this.bridge.saveFile("recording", suggestFileName(this.session.rec.meta()), bytes);
      if (path) {
        this.savedAtFrames = this.session.totalFrames;
        this.toast(`記録を保存しました: ${path}`, "ok");
      }
      return !!path;
    } catch (err) {
      this.toast(`保存に失敗しました: ${(err as Error).message}`, "warn");
      return false;
    } finally {
      this.busy = false;
    }
  }


  /** 閉じたら失われる記録があるか。自動検証から見えるよう公開している。 */
  hasUnsavedWork(): boolean {
    const n = this.session.totalFrames;
    return n > 60 && n !== this.savedAtFrames;
  }

  /** 閉じる直前の確認。**記録は明示的に保存する決まりなので、ここで聞かないと
   *  そのまま消える。** 1 時間遊んだ記録が黙って消えるのが最悪の結末。 */
  private async confirmClose(): Promise<void> {
    const t = formatTime(this.session.totalFrames);
    const save = confirm(
      `記録 (${t}) がまだ保存されていません。\n\n` +
      `[OK] 保存してから閉じる\n[キャンセル] 保存せずに閉じる`,
    );
    if (save && !(await this.saveRecording())) return; // 保存を取りやめたら閉じない
    this.allowClose = true;
    window.close();
  }

  private async openRecording(): Promise<void> {
    const f = await this.bridge.openFile("recording");
    if (!f) return;
    this.busy = true;
    try {
      const { rec } = await parseToRecorder(f.bytes);
      if (!this.romInfo || this.romInfo.sha1 !== rec.rom.sha1) {
        const want = `${rec.rom.name} (sha1 ${rec.rom.sha1.slice(0, 12)}…)`;
        this.toast(`この記録には ROM「${want}」が要ります。続けて ROM を選んでください`, "warn");
        const r = await this.bridge.openFile("rom");
        if (!r) return;
        const info = await identifyRom(r.bytes, r.name);
        if (info.sha1 !== rec.rom.sha1) {
          if (!confirm("選んだ ROM が記録と一致しません。そのまま開くと、正しく再現できない可能性があります。続けますか？")) return;
        }
        await this.startAudio();
        await this.session.loadRom(r.bytes, info, displayTitle(r.name));
        this.romInfo = info;
        this.savedAtFrames = -1;
        $("rom-name").textContent = `${displayTitle(r.name)}  (マッパー ${info.mapper})`;
        $("drop-hint").classList.add("hide");
        for (const id of ["btn-save-rec", "btn-export"]) ($(id) as HTMLButtonElement).disabled = false;
      }
      const resume = confirm(
        `記録「${rec.title}」(${formatTime(rec.frameCount)}) を開きました。\n\n` +
        `[OK] 続きから記録する\n[キャンセル] 最初から再生する`,
      );
      await this.session.adoptRecording(rec, resume ? "tail" : 0);
      this.session.mode = resume ? "record" : "playback";
      this.savedAtFrames = rec.frameCount;   // 読み込んだ内容はディスクにある
      this.audio.clear();
      this.setPaused(false);
      this.setSpeed(NORMAL_SPEED);
      this.toast(resume ? "続きから記録します" : "最初から再生します", "ok");
    } catch (err) {
      this.toast(`記録を開けませんでした: ${(err as Error).message}`, "warn");
    } finally {
      this.busy = false;
    }
  }

  private async saveStateFile(): Promise<void> {
    if (!this.session.rec) return;
    const state = this.session.emu.saveState();
    const name = `${this.session.rec.title}-f${this.session.frame}.state`;
    const path = await this.bridge.saveFile("state", name, state);
    if (path) this.toast("ステートを保存しました", "ok");
  }

  private async loadStateFile(): Promise<void> {
    const f = await this.bridge.openFile("state");
    if (!f || !this.session.rec) return;
    // 外部のステートから始めると、電源投入からの再現ができなくなる。
    // 記録を作り直し、そのステートを開始点として同梱する。
    if (!confirm("外部のステートを読み込むと、ここまでの記録が終わり、そのステートから新しい記録が始まります。よろしいですか？")) return;
    this.busy = true;
    try {
      if (!this.session.emu.loadState(f.bytes)) throw new Error("このステートは読み込めません");
      const rec = this.session.rec;
      const next = new Recorder(rec.rom, rec.title, "savestate");
      next.originState = f.bytes.slice();
      this.session.rec = next;
      this.session.emu.frameCount = 0;
      this.session.mode = "record";
      this.audio.clear();
      this.toast("ステートから新しい記録を始めます", "ok");
    } catch (err) {
      this.toast((err as Error).message, "warn");
    } finally {
      this.busy = false;
    }
  }

  // ---------------------------------------------------------------- 描画

  private render(): void {
    const px = this.session.pixels;
    this.image.data.set(px);
    this.ctx.putImageData(this.image, 0, 0);
    this.drawOsd();
  }

  private drawOsd(): void {
    const parts: string[] = [];
    if (this.paused) parts.push("⏸ 一時停止");
    if (this.speedIndex !== NORMAL_SPEED) parts.push(`速度 ${SPEED_LABEL[this.speedIndex]}`);
    if (this.input.turbo.state.mode !== "off") {
      const l = [this.input.turbo.latched("A") ? "A" : "", this.input.turbo.latched("B") ? "B" : ""].filter(Boolean).join("");
      parts.push(`連射 ${this.input.turbo.state.mode === "hold" ? "H" : "T"}${l ? ":" + l : ""}`);
    }
    if (this.input.ways === 4) parts.push("4-WAY");
    if (this.rewindHint && this.session.mode === "playback") {
      parts.push("ボタンを押すとここから記録し直します");
    }
    $("osd").textContent = parts.join("   ");

    const hint = $("combo-hint");
    if (this.input.pad.comboHeld) {
      hint.hidden = false;
      hint.innerHTML = L_COMBO_HELP.map(([k, v]) => `<b>${k}</b> ${v}`).join("<br />");
    } else {
      hint.hidden = true;
    }
  }

  private updateStatus(): void {
    const rec = this.session.rec;
    const dot = $("rec-dot");
    const label = $("rec-label");
    if (!rec) {
      dot.className = "dot";
      label.textContent = "待機中";
    } else if (this.session.mode === "playback") {
      dot.className = "dot play";
      label.textContent = "再生中";
    } else {
      dot.className = "dot rec";
      label.textContent = "記録中";
    }
    $("time").textContent = formatTime(this.session.frame);
    $("players").textContent = this.input.twoPlayers ? "2P 接続中" : "";
    $("frames").textContent = rec
      ? `${this.session.frame.toLocaleString()} / ${rec.frameCount.toLocaleString()} フレーム${rec.rewinds ? `・巻き戻し ${rec.rewinds} 回` : ""}`
      : "0 フレーム";
    ($("btn-takeover") as HTMLElement).hidden = this.session.mode !== "playback";

    if (this.settings.showPerf || new URLSearchParams(location.search).has("perf")) {
      $("perf").textContent =
        `rAF ${this.perf.raf.toFixed(1)}ms  emu ${this.perf.emu.toFixed(2)}ms  ` +
        `RA ${this.session.lastStats.runAheadMs.toFixed(2)}ms  入力 ${this.perf.latency.toFixed(1)}ms  ` +
        `音 ${this.audio.latencyMs().toFixed(1)}ms  ${describeInput(this.session.lastInput[0])}`;
    }
  }

  private drawTimeline(): void {
    const c = this.tl;
    const w = c.clientWidth;
    if (c.width !== w) c.width = w;
    const g = this.tlCtx;
    const h = c.height;
    g.clearRect(0, 0, w, h);
    const rec = this.session.rec;
    const total = rec?.frameCount ?? 0;

    g.fillStyle = "#252836";
    g.fillRect(0, 0, w, h);
    if (!rec || total === 0) {
      g.fillStyle = "#565b70";
      g.font = "12px system-ui";
      g.fillText("ROM を読み込むと、ここに記録が伸びていきます", 10, h / 2 + 4);
      return;
    }

    const x = (f: number): number => (f / total) * w;
    // 記録済みの区間
    g.fillStyle = this.session.mode === "playback" ? "#1d4a5c" : "#4a2430";
    g.fillRect(0, 8, w, h - 16);
    // 現在位置までの塗り
    g.fillStyle = this.session.mode === "playback" ? "#4dd4ff" : "#ff4d5e";
    g.fillRect(0, 8, x(this.session.frame), h - 16);
    // 目印
    for (const m of rec.events) {
      g.fillStyle = m.type === "reset" ? "#ffcc4d" : "#57d98a";
      g.fillRect(Math.min(w - 2, x(m.frame)), 2, 2, h - 4);
    }
    // 現在位置
    g.fillStyle = "#fff";
    g.fillRect(Math.min(w - 2, x(this.session.frame)), 0, 2, h);
    // 目盛り (10 秒ごと)
    g.fillStyle = "rgba(255,255,255,.18)";
    for (let f = 0; f < total; f += 600) g.fillRect(x(f), h - 5, 1, 5);
  }

  // ---------------------------------------------------------------- 配線

  private wire(): void {
    $("btn-rom").onclick = () => void this.openRom();
    $("btn-save-rec").onclick = () => void this.saveRecording();
    $("btn-open-rec").onclick = () => void this.openRecording();
    $("btn-export").onclick = () => this.openExport();
    $("btn-settings").onclick = () => this.togglePanel("panel-settings");
    $("btn-help").onclick = () => this.togglePanel("panel-help");
    for (const b of document.querySelectorAll<HTMLElement>("[data-close]")) {
      b.onclick = () => { ($(b.dataset.close!) as HTMLElement).hidden = true; };
    }

    $("btn-pause").onclick = () => this.setPaused(!this.paused);
    $("btn-step").onclick = () => { if (!this.paused) this.setPaused(true); this.stepOnce++; };
    $("btn-restart").onclick = () => this.playFromStart();
    $("btn-mark").onclick = () => this.addMarker();
    $("btn-takeover").onclick = () => { this.session.takeover(); this.toast("ここから自分のプレイを記録します"); };
    $("btn-turbo").onclick = () => this.cycleTurbo();
    $("btn-ways").onclick = () => this.toggleWays();

    // 巻き戻し・早送りは「押している間」。マウスでも同じ感触にする。
    // 16ms ごとに呼ばれるので、キーボードで押しているのと同じ量になる。
    this.holdButton("btn-rewind", () => this.doRewind(16));
    this.holdButton("btn-ff", () => { this.acc += FRAME_MS * 4; });

    ($("speed") as HTMLSelectElement).onchange = (e) =>
      this.setSpeed(Number((e.target as HTMLSelectElement).value));
    ($("volume") as HTMLInputElement).oninput = (e) => {
      const v = Number((e.target as HTMLInputElement).value) / 100;
      this.audio.setVolume(v);
      this.settings.volume = v;
      this.saveSettings();
    };

    this.tl.onpointerdown = (e) => this.seekFromPointer(e);
    this.tl.onpointermove = (e) => { if (e.buttons & 1) this.seekFromPointer(e); };

    // 設定
    const resetKeeps = $("set-reset-keeps") as HTMLInputElement;
    resetKeeps.checked = this.settings.resetKeepsRecording;
    resetKeeps.onchange = () => {
      this.settings.resetKeepsRecording = resetKeeps.checked;
      this.session.resetClearsRecording = !resetKeeps.checked;
      this.saveSettings();
    };
    const confirmDiscard = $("set-confirm-discard") as HTMLInputElement;
    confirmDiscard.checked = this.settings.confirmDiscard;
    confirmDiscard.onchange = () => { this.settings.confirmDiscard = confirmDiscard.checked; this.saveSettings(); };

    const ra = $("set-runahead") as HTMLSelectElement;
    ra.value = String(this.settings.runAhead);
    ra.onchange = () => {
      this.settings.runAhead = Number(ra.value);
      void this.session.setRunAhead(this.settings.runAhead);
      this.saveSettings();
      this.updateRunAheadCost();
    };

    const rate = $("set-turbo-rate") as HTMLInputElement;
    rate.value = String(this.settings.turboRate);
    rate.oninput = () => {
      this.settings.turboRate = Number(rate.value);
      this.input.turbo.setRate(this.settings.turboRate);
      $("turbo-rate-label").textContent = `${this.settings.turboRate} Hz`;
      this.saveSettings();
    };
    $("turbo-rate-label").textContent = `${this.settings.turboRate} Hz`;

    const uncap = $("set-uncap") as HTMLInputElement;
    uncap.checked = this.settings.uncapFrameRate;
    uncap.onchange = () => {
      this.settings.uncapFrameRate = uncap.checked;
      this.saveSettings();
      this.toast("次回の起動から変わります");
    };
    const perf = $("set-perf") as HTMLInputElement;
    perf.checked = this.settings.showPerf;
    perf.onchange = () => { this.settings.showPerf = perf.checked; this.saveSettings(); };

    const rs = $("set-rewind-speed") as HTMLSelectElement;
    rs.value = String(this.settings.rewindSpeed);
    rs.onchange = () => { this.settings.rewindSpeed = Number(rs.value); this.saveSettings(); };

    ($("volume") as HTMLInputElement).value = String(Math.round(this.settings.volume * 100));

    // ドラッグ＆ドロップ
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      void file.arrayBuffer().then((buf) => {
        const bytes = new Uint8Array(buf);
        if (file.name.toLowerCase().endsWith(".rnes")) void this.adoptDropped(bytes);
        else void this.loadRomBytes(bytes, file.name);
      });
    });

    window.addEventListener("beforeunload", (e) => {
      if (this.allowClose || !this.hasUnsavedWork()) return;
      e.preventDefault();
      e.returnValue = "";
      void this.confirmClose();
    });

    // 音声は最初のクリックで起こす (自動再生制限)。
    const wake = (): void => { void this.startAudio(); document.removeEventListener("pointerdown", wake); };
    document.addEventListener("pointerdown", wake);

    this.wireExport();
  }

  /** 外から記録を渡されたときの入口 (起動引数、ドラッグ＆ドロップ)。 */
  async openRecordingBytes(bytes: Uint8Array): Promise<void> {
    await this.adoptDropped(bytes);
  }

  private async adoptDropped(bytes: Uint8Array): Promise<void> {
    try {
      const { rec } = await parseToRecorder(bytes);
      if (!this.romInfo) { this.toast("先に ROM を読み込んでください", "warn"); return; }
      await this.session.adoptRecording(rec, "tail");
      this.toast("記録を読み込みました", "ok");
    } catch (err) {
      this.toast((err as Error).message, "warn");
    }
  }

  private holdButton(id: string, tick: () => void): void {
    const el = $(id);
    let timer = 0;
    const start = (): void => {
      tick();
      timer = window.setInterval(tick, 16);
    };
    const stop = (): void => { clearInterval(timer); timer = 0; };
    el.onpointerdown = start;
    el.onpointerup = stop;
    el.onpointerleave = stop;
    el.onpointercancel = stop;
  }

  private seekFromPointer(e: PointerEvent): void {
    const rec = this.session.rec;
    if (!rec || rec.frameCount === 0) return;
    const r = this.tl.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    this.session.mode = "playback";
    this.session.seek(Math.round(t * rec.frameCount));
    this.audio.clear();
  }

  private togglePanel(id: string): void {
    const p = $(id) as HTMLElement;
    for (const other of document.querySelectorAll<HTMLElement>(".panel")) if (other.id !== id) other.hidden = true;
    p.hidden = !p.hidden;
    if (id === "panel-settings" && !p.hidden) this.updateRunAheadCost();
  }

  private syncControls(): void {
    const speed = $("speed") as HTMLSelectElement;
    if (speed.value !== String(this.speedIndex)) speed.value = String(this.speedIndex);
    const pause = $("btn-pause");
    pause.textContent = this.paused ? "▶" : "⏸";
    pause.classList.toggle("on", this.paused);
    const mode = this.input.turbo.state.mode;
    const tb = $("btn-turbo");
    tb.textContent = TURBO_LABEL[mode];
    tb.setAttribute("aria-pressed", mode === "off" ? "false" : "true");
    $("turbo-help").textContent = TURBO_HELP[mode];
    const wb = $("btn-ways");
    wb.textContent = this.input.ways === 4 ? "4-WAY" : "8-WAY";
    wb.setAttribute("aria-pressed", this.input.ways === 4 ? "true" : "false");
  }

  private updateRunAheadCost(): void {
    const s = this.session.lastStats;
    const per = s.emuMs + s.runAheadMs + s.stateMs;
    $("runahead-cost").textContent = this.session.rec
      ? `1 フレームあたり ${per.toFixed(2)} ms（予算 ${FRAME_MS.toFixed(2)} ms）\n` +
        `内訳  本体 ${s.emuMs.toFixed(2)} ms ／ 先読み ${s.runAheadMs.toFixed(2)} ms ／ 状態保存 ${s.stateMs.toFixed(2)} ms`
      : "ROM を読み込むと実測値が出ます";
  }

  private async showEnvironment(): Promise<void> {
    const backend = await this.bridge.videoBackend();
    $("env-info").textContent =
      `実行環境: ${this.bridge.name}\n` +
      `動画書き出し: ${backend ?? "使えません（ffmpeg が見つかりません）"}\n` +
      `音声: ${this.audio.sampleRate} Hz`;
    $("exp-backend").textContent = backend ? `ffmpeg: ${backend}` : "ffmpeg が見つかりません。書き出しはできません。";
  }

  private buildHelp(): void {
    const keyRows: [string, string][] = [
      ["← ↑ → ↓", "十字キー"],
      ["Z / X", "B / A"],
      ["A / S", "B 連射 / A 連射"],
      ["Enter / 右Shift", "START / SELECT"],
      ["Backspace", "巻き戻し（押している間）"],
      ["Tab", "早送り（押している間）"],
      ["Space", "一時停止 / 再開"],
      ["F", "コマ送り（押しっぱなしで連続）"],
      ["[ / ]", "速度を下げる / 上げる"],
      ["F1 / F2", "今の地点を覚える / 覚えた地点へ戻る"],
      ["F3 / F4", "ステートをファイルへ保存 / 読み込み"],
      ["F5", "記録を保存"],
      ["M", "目印を打つ"],
      ["T", "連射モード切替"],
      ["W", "4-way / 8-way 切替"],
      ["P", "最初から再生"],
      ["Ctrl + R", "リセット"],
    ];
    $("help-keys").innerHTML = keyRows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
    $("help-pad").innerHTML = L_COMBO_HELP.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
    $("help-pad-normal").innerHTML = [
      ["十字キー / 左スティック", "十字キー"],
      ["B / A", "B / A"],
      ["Y / X", "B 連射 / A 連射"],
      ["SELECT / START", "SELECT / START"],
    ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
    void DEFAULT_BINDINGS;
  }

  // ---------------------------------------------------------------- 書き出し

  private openExport(): void {
    const rec = this.session.rec;
    if (!rec) return;
    ($("exp-from") as HTMLInputElement).value = "0";
    ($("exp-to") as HTMLInputElement).value = String(rec.frameCount);
    ($("exp-title") as HTMLInputElement).value = rec.title;
    this.buildExportMarkers();
    this.updateExportRangeLabel();
    this.togglePanel("panel-export");
  }

  /** 目印を押すだけで範囲を決められるようにする。
   *  フレーム番号を手で打たせるのは、目的からして遠回りすぎる。 */
  private buildExportMarkers(): void {
    const rec = this.session.rec;
    const row = $("exp-markers-row") as HTMLElement;
    const box = $("exp-markers");
    box.textContent = "";
    const marks = rec?.events.filter((e) => e.type === "marker") ?? [];
    row.hidden = marks.length === 0;
    if (!rec || marks.length === 0) return;

    const points = [0, ...marks.map((m) => m.frame), rec.frameCount];
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i];
      const to = points[i + 1];
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `${formatTime(from)} 〜 ${formatTime(to)}`;
      b.onclick = () => {
        ($("exp-from") as HTMLInputElement).value = String(from);
        ($("exp-to") as HTMLInputElement).value = String(to);
        this.updateExportRangeLabel();
      };
      box.append(b);
    }
  }

  private updateExportRangeLabel(): void {
    const from = Number(($("exp-from") as HTMLInputElement).value);
    const to = Number(($("exp-to") as HTMLInputElement).value);
    const n = Math.max(0, to - from);
    $("exp-range-time").textContent = `${n.toLocaleString()} フレーム = ${formatTime(n)}`;
  }

  private wireExport(): void {
    const s = this.settings.exportSettings;
    const scale = $("exp-scale") as HTMLSelectElement;
    const fps = $("exp-fps") as HTMLSelectElement;
    const crf = $("exp-crf") as HTMLInputElement;
    const audio = $("exp-audio") as HTMLInputElement;
    scale.value = String(s.scale);
    fps.value = String(s.fps);
    crf.value = String(s.crf);
    audio.checked = s.audio;
    $("exp-crf-label").textContent = String(s.crf);
    crf.oninput = () => { $("exp-crf-label").textContent = crf.value; };

    for (const el of [$("exp-from"), $("exp-to")]) el.oninput = () => this.updateExportRangeLabel();
    $("exp-all").onclick = () => {
      ($("exp-from") as HTMLInputElement).value = "0";
      ($("exp-to") as HTMLInputElement).value = String(this.session.rec?.frameCount ?? 0);
      this.updateExportRangeLabel();
    };

    $("exp-start").onclick = () => void this.runExport();
    $("exp-cancel").onclick = () => this.exporter.cancel();
  }

  private async runExport(): Promise<void> {
    const rec = this.session.rec;
    const rom = this.session.romData();
    if (!rec || !rom) return;
    const settings: ExportSettings = {
      scale: Number(($("exp-scale") as HTMLSelectElement).value) as 1 | 2 | 3 | 4,
      fps: Number(($("exp-fps") as HTMLSelectElement).value),
      crf: Number(($("exp-crf") as HTMLInputElement).value),
      audio: ($("exp-audio") as HTMLInputElement).checked,
      overlayInput: false,
    };
    this.settings.exportSettings = settings;
    this.saveSettings();

    const from = Number(($("exp-from") as HTMLInputElement).value);
    const to = Number(($("exp-to") as HTMLInputElement).value);
    const title = ($("exp-title") as HTMLInputElement).value.trim() || rec.title;
    rec.title = title;
    const bar = $("exp-bar");
    const text = $("exp-text");
    ($("exp-progress") as HTMLElement).hidden = false;
    ($("exp-cancel") as HTMLElement).hidden = false;
    ($("exp-start") as HTMLButtonElement).disabled = true;
    this.busy = true;
    this.audio.drop();

    try {
      const path = await this.exporter.run(
        this.bridge, rom, rec, { from, to }, settings,
        (p) => {
          const pct = p.total ? (p.frame / p.total) * 100 : 0;
          bar.style.width = `${pct}%`;
          const rate = p.elapsed > 0 ? p.frame / p.elapsed : 0;
          const left = rate > 0 ? (p.total - p.frame) / rate : 0;
          text.textContent = p.phase === "prepare"
            ? "準備しています…"
            : `${p.frame.toLocaleString()} / ${p.total.toLocaleString()} フレーム  ${pct.toFixed(1)}%  残り ${formatSeconds(left)}`;
        },
        `${title.replace(/[\\/:*?"<>|]/g, "_")}.mp4`,
      );
      text.textContent = `書き出しました: ${path}`;
      this.toast(`動画を書き出しました: ${path}`, "ok");
    } catch (err) {
      text.textContent = (err as Error).message;
      this.toast(`書き出しに失敗しました: ${(err as Error).message}`, "warn");
    } finally {
      this.busy = false;
      ($("exp-cancel") as HTMLElement).hidden = true;
      ($("exp-start") as HTMLButtonElement).disabled = false;
      this.lastTs = 0;
    }
  }

  // ---------------------------------------------------------------- 小物

  private toast(msg: string, kind: "" | "ok" | "warn" = ""): void {
    const el = document.createElement("div");
    el.className = `toast ${kind}`.trim();
    el.textContent = msg;
    $("toasts").append(el);
    setTimeout(() => el.remove(), 3200);
  }
}

export function formatTime(frames: number): string {
  const t = frames / NES_FPS;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

export function formatSeconds(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}
