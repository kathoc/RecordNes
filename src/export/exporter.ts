/** 記録から mp4 を書き出す。
 *
 *  実時間で画面を録るのではなく、**記録を最初から決定論的に走らせ直す**。
 *  だからフレーム落ちも描画の乱れも原理的に入らない。遊んでいるときに
 *  1/8 速やコマ送りを使っていても、出てくる動画は常に実速度になる。
 *
 *  音ズレについて。NES の 1 フレームは実測 60.0978fps 相当で、動画としてよく使う
 *  60fps や 59.94fps とは一致しない。宣言した fps と実際の音の長さが食い違うと、
 *  10 分で 1 秒ずれる。そこで**映像は選んだ fps ちょうどで出し、音声をフレームごとに
 *  必要な本数へ引き伸ばす**。1 フレーム分の音を、そのフレームに要る本数へ線形補間で
 *  写すだけなので、ずれは構造的に生じない。音程の変化は 0.16%(2.8 セント)で聞き取れない。 */

import { Emu, SCREEN_H, SCREEN_W } from "../core/emu.ts";
import { Recorder } from "../record/recorder.ts";
import type { PlatformBridge, VideoOptions } from "../platform/types.ts";

export interface ExportRange {
  /** 書き出す最初のフレーム (この時点の画面が 1 枚目) */
  from: number;
  /** 書き出す最後のフレーム (含まない) */
  to: number;
}

export interface ExportSettings {
  scale: 1 | 2 | 3 | 4;
  fps: number;
  crf: number;
  audio: boolean;
  /** 入力の表示を焼き込むか */
  overlayInput: boolean;
}

export interface ExportProgress {
  phase: "prepare" | "encode" | "finish";
  frame: number;
  total: number;
  /** 経過秒 */
  elapsed: number;
}

export const DEFAULT_EXPORT: ExportSettings = {
  scale: 2,
  fps: 60,
  crf: 18,
  audio: true,
  overlayInput: false,
};

/** 最近傍で整数倍に拡大する。NES の絵はこれ以外で拡大してはいけない。 */
export function scaleNearest(src: Uint8Array, scale: number, dst: Uint8Array): void {
  if (scale === 1) {
    dst.set(src);
    return;
  }
  const w = SCREEN_W * scale;
  for (let y = 0; y < SCREEN_H; y++) {
    const rowStart = y * scale * w * 4;
    // 1 行を横に伸ばす
    for (let x = 0; x < SCREEN_W; x++) {
      const s = (y * SCREEN_W + x) * 4;
      const r = src[s], g = src[s + 1], b = src[s + 2], a = src[s + 3];
      for (let k = 0; k < scale; k++) {
        const d = rowStart + (x * scale + k) * 4;
        dst[d] = r; dst[d + 1] = g; dst[d + 2] = b; dst[d + 3] = a;
      }
    }
    // 伸ばした行を縦に複製する
    for (let k = 1; k < scale; k++) {
      dst.copyWithin(rowStart + k * w * 4, rowStart, rowStart + w * 4);
    }
  }
}

/** 1 フレーム分の音声を、必要な本数へ線形補間で写す。 */
export function resampleFrame(input: Float32Array, need: number, carry: number, out: Int16Array): number {
  if (need <= 0) return input.length ? input[input.length - 1] : carry;
  const n = input.length;
  if (n === 0) {
    out.fill(Math.max(-32768, Math.min(32767, Math.round(carry * 32767))), 0, need);
    return carry;
  }
  for (let i = 0; i < need; i++) {
    // [carry, input[0..n-1]] の n+1 本を、need 本へ写す
    const pos = (i * n) / need;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = i0 === 0 ? carry : input[i0 - 1];
    const b = input[Math.min(i0, n - 1)];
    const v = a + (b - a) * frac;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return input[n - 1];
}

export class Exporter {
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
  }

  /**
   * @param rom     記録に対応する ROM の中身
   * @param rec     書き出す記録
   * @param range   書き出す区間
   */
  async run(
    bridge: PlatformBridge,
    rom: Uint8Array,
    rec: Recorder,
    range: ExportRange,
    settings: ExportSettings,
    onProgress: (p: ExportProgress) => void,
    suggestedName = "recordnes.mp4",
  ): Promise<string> {
    this.cancelled = false;
    const t0 = Date.now();
    const from = Math.max(0, Math.min(range.from, rec.frameCount));
    const to = Math.max(from, Math.min(range.to, rec.frameCount));
    const total = to - from;
    if (total === 0) throw new Error("書き出す区間が空です");

    const width = SCREEN_W * settings.scale;
    const height = SCREEN_H * settings.scale;

    onProgress({ phase: "prepare", frame: 0, total, elapsed: 0 });

    // 書き出し用の実体。記録用とは別に立てて、遊んでいる方を止めない。
    const emu = new Emu(48000);
    await emu.load(rom);

    // 開始位置まで無音で進める。キーフレームがあればそこから。
    const k = rec.nearestState(from);
    if (k) {
      emu.loadState(k.state);
      emu.frameCount = k.frame;
    }
    emu.setSink(null);
    while (emu.frameCount < from) {
      const f = emu.frameCount;
      for (const e of rec.events) if (e.frame === f && e.type === "reset") emu.reset();
      const [a, b] = rec.inputAt(f);
      emu.step(a, b);
      if (this.cancelled) throw new Error("書き出しを取りやめました");
    }

    const opts: VideoOptions = {
      path: suggestedName,
      width,
      height,
      fps: settings.fps,
      sampleRate: emu.sampleRate,
      crf: settings.crf,
      audio: settings.audio,
    };
    const job = await bridge.startVideo(opts);

    const scaled = new Uint8Array(width * height * 4);
    let pending: number[] = [];
    emu.setSink(settings.audio ? (s) => pending.push(s) : null);
    let carry = 0;
    let producedSamples = 0;
    const audioBuf = new Int16Array(4096);

    try {
      for (let i = 0; i < total; i++) {
        if (this.cancelled) throw new Error("書き出しを取りやめました");
        const f = emu.frameCount;
        for (const e of rec.events) if (e.frame === f && e.type === "reset") emu.reset();
        const [a, b] = rec.inputAt(f);
        pending.length = 0;
        emu.step(a, b);

        scaleNearest(emu.pixels, settings.scale, scaled);

        let audio: Int16Array | null = null;
        if (settings.audio) {
          // このフレームの終わりまでに出ているべき累計本数から、今回の本数を決める。
          const wantTotal = Math.floor(((i + 1) * emu.sampleRate) / settings.fps);
          const need = wantTotal - producedSamples;
          const view = audioBuf.subarray(0, Math.min(need, audioBuf.length));
          carry = resampleFrame(Float32Array.from(pending), view.length, carry, audioBuf);
          producedSamples += view.length;
          audio = view;
        }
        await job.write(scaled, audio);

        if (i % 30 === 0 || i === total - 1) {
          onProgress({ phase: "encode", frame: i + 1, total, elapsed: (Date.now() - t0) / 1000 });
          // UI を固まらせない。
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      onProgress({ phase: "finish", frame: total, total, elapsed: (Date.now() - t0) / 1000 });
      return await job.finish();
    } catch (err) {
      await job.cancel().catch(() => {});
      throw err;
    }
  }
}
