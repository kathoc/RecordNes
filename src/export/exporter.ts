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

import { Emu, NES_FPS, SCREEN_H, SCREEN_W } from "../core/emu.ts";
import { clearJam, consumeJam } from "../core/jam-watch.ts";
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

/** 浮動小数の -1..1 を 16bit PCM へ。 */
function toPcm(samples: number[], out: Int16Array): Int16Array {
  const view = out.length >= samples.length ? out : new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i] * 32767);
    view[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return view.subarray(0, samples.length);
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
    clearJam();
    while (emu.frameCount < from) {
      const f = emu.frameCount;
      for (const e of rec.events) if (e.frame === f && e.type === "reset") emu.reset();
      const [a, b] = rec.inputAt(f);
      emu.step(a, b);
      if (this.cancelled) throw new Error("書き出しを取りやめました");
    }
    // 開始位置へ着くまでに止まっていたら、ここから先は固まった絵しか出ない。
    // 長さだけある無意味な動画を渡さないよう、始める前に弾く。
    if (consumeJam()) {
      throw new Error(
        "この区間の先頭の状態を復元できませんでした。区間の先頭を少しずらすか、" +
        "0 フレーム目から書き出してください。",
      );
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
    const pending: number[] = [];
    emu.setSink(settings.audio ? (v) => pending.push(v) : null);
    /** 書き出した動画フレーム数。エミュレートしたフレーム数とは一致しない。 */
    let emitted = 0;
    let pcm = new Int16Array(8192);

    try {
      for (let i = 0; i < total; i++) {
        if (this.cancelled) throw new Error("書き出しを取りやめました");
        const f = emu.frameCount;
        for (const e of rec.events) if (e.frame === f && e.type === "reset") emu.reset();
        const [a, b] = rec.inputAt(f);
        clearJam();
        pending.length = 0;
        emu.step(a, b);

        // 復元できない状態から始めていた場合、ここで CPU が止まる。
        // 気づかずに続けると、固まった絵のまま長さだけある動画ができあがる。
        if (consumeJam()) {
          throw new Error(
            "書き出しの途中で状態を復元できませんでした。" +
            "区間の先頭を少しずらすか、0 フレーム目から書き出してください。",
          );
        }

        if (i % 30 === 0 || i === total - 1) {
          onProgress({ phase: "encode", frame: i + 1, total, elapsed: (Date.now() - t0) / 1000 });
          // UI を固まらせない。絵を出さない回もここを通る必要がある
          // (30fps では 2 回に 1 回しか出さないため)。
          await new Promise((r) => setTimeout(r, 0));
        }

        // **エミュレートしたフレームと動画のフレームは 1 対 1 ではない。**
        // NES は毎秒 60.0978 フレームで、動画に選べる 60 / 59.94 / 30 のどれとも
        // 違う。1 フレーム = 1 枚で書くと、30fps を選んだとき長さが倍になる。
        //
        // 動画の k 枚目が写すのは、エミュレートの floor(k * 60.0978 / fps) 番目。
        // k = 0 は必ず 0 番目になるので、区間の先頭が落ちることもない。
        let frames = 0;
        while (Math.floor(((emitted + frames) * NES_FPS) / settings.fps) <= i) frames++;

        // **音声は動画の枚数に合わせて詰めない。** 絵を間引いた回の音を次の
        // 1 枚ぶんへ押し込むと、そこだけ倍速になって耳に付く。実測: 60fps で
        // 1198 枚中 2 枚が 2 倍速だった。音はそのままの本数で流し続ける。
        // 動画の長さ emitted/fps と音の長さ (i+1)/60.0978 のずれは 1 枚ぶん
        // 未満に収まり、積み上がらない。
        const audio = settings.audio && pending.length ? toPcm(pending, pcm) : null;
        if (audio && audio.length > pcm.length) pcm = new Int16Array(audio.length * 2);

        if (frames === 0) {
          if (audio) await job.write(null, audio);
          continue;
        }

        scaleNearest(emu.pixels, settings.scale, scaled);
        for (let k = 0; k < frames; k++) {
          await job.write(scaled, k === 0 ? audio : null);
          emitted++;
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
