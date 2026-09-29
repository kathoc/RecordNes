/** @nesjs/core の薄い包み。
 *
 *  上の層(記録・再生・書き出し)が触るのはこのクラスだけにして、コアを差し替えても
 *  記録形式が壊れないようにする。ここで守る約束は 3 つ。
 *
 *  1. `runFrame` は必ず「入力を入れてから 1 フレーム進める」。順序を呼ぶ側に委ねない。
 *  2. 入力は 1 バイト。ビット順は A,B,SELECT,START,UP,DOWN,LEFT,RIGHT (bit0 が A)。
 *  3. `saveState` / `loadState` の往復は、続けて実行した結果と完全に一致する
 *     (docs/spec.md の実測表)。 */

import { NES } from "@nesjs/core";

export const SCREEN_W = 256;
export const SCREEN_H = 240;

/** 入力 1 バイトのビット位置。NESControllerButton と同じ順。 */
export const BTN = {
  A: 1 << 0,
  B: 1 << 1,
  SELECT: 1 << 2,
  START: 1 << 3,
  UP: 1 << 4,
  DOWN: 1 << 5,
  LEFT: 1 << 6,
  RIGHT: 1 << 7,
} as const;

export type ButtonName = keyof typeof BTN;
export const BUTTON_NAMES: ButtonName[] = ["A", "B", "SELECT", "START", "UP", "DOWN", "LEFT", "RIGHT"];

/** 音声の受け口。差し替えて「捨てる」「鳴らす」「貯める」を切り替える。 */
export interface SampleSink {
  (sample: number): void;
}

const DROP: SampleSink = () => {};

export class Emu {
  /** 直近に描かれたフレーム。RGBA 8bit × 256 × 240。 */
  readonly pixels = new Uint8Array(SCREEN_W * SCREEN_H * 4);
  /** 電源投入(またはリセット)からのフレーム数。記録の添字と一致させる。 */
  frameCount = 0;
  loaded = false;
  readonly sampleRate: number;

  private nes: NES;
  private sink: SampleSink = DROP;
  private rom: Uint8Array | null = null;

  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.nes = new NES({ audioSampleRate: sampleRate });
    this.nes.setRenderer({
      renderFrame: (rgba: Uint8Array) => {
        this.pixels.set(rgba);
      },
    });
    this.nes.setAudioInterface({
      outputSample: (s: number) => this.sink(s),
      flushFrame: () => {},
    });
  }

  /** 音声の行き先を差し替える。早送り中は `dropAudio()` で捨てる。 */
  setSink(sink: SampleSink | null): void {
    this.sink = sink ?? DROP;
  }

  async load(rom: Uint8Array): Promise<void> {
    this.loaded = false;
    this.rom = rom.slice();
    await this.nes.loadROM(this.rom);
    this.frameCount = 0;
    this.pixels.fill(0);
    this.setInputs(0, 0);
    this.loaded = true;
  }

  /** リセット。フレーム数は 0 に戻さない — 記録のタイムラインは切れずに続く。
   *  記録を切るかどうかは上の層(Recorder)の判断。 */
  reset(): void {
    this.nes.reset();
    this.setInputs(0, 0);
  }

  setInputs(p1: number, p2: number): void {
    this.nes.setInput(1, p1 & 0xff);
    this.nes.setInput(2, p2 & 0xff);
  }

  /** 入力を適用して 1 フレーム進める。戻り値は進めたあとのフレーム番号。 */
  step(p1: number, p2: number): number {
    this.setInputs(p1, p2);
    this.nes.runFrame();
    return ++this.frameCount;
  }

  saveState(): Uint8Array {
    return this.nes.createBinarySaveState();
  }

  loadState(state: Uint8Array): boolean {
    return this.nes.loadBinarySaveState(state);
  }

  /** バッテリーバックアップ (.sav)。ROM 側が対応していなければ null。 */
  sram(): Uint8Array | null {
    const s = this.nes.saveSRAM();
    return s ? Uint8Array.from(s) : null;
  }

  restoreSram(data: Uint8Array): void {
    this.nes.loadSRAM([...data]);
  }

  romInfoString(): string {
    return this.nes.getROMInfoString() ?? "";
  }

  mapperNumber(): number {
    return this.nes.getROMInfo()?.mapperNumber ?? -1;
  }
}

/** 入力バイトを "→A" のような読める形にする。HUD とデバッグ用。 */
export function describeInput(byte: number): string {
  const glyph: Record<ButtonName, string> = {
    UP: "↑", DOWN: "↓", LEFT: "←", RIGHT: "→",
    A: "A", B: "B", SELECT: "s", START: "S",
  };
  const order: ButtonName[] = ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "START", "B", "A"];
  return order.filter((n) => byte & BTN[n]).map((n) => glyph[n]).join("") || "-";
}
