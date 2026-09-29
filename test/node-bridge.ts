/** テスト用のプラットフォーム実装。書き出しの中身は製品と同じ shared/ を使う。 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import type { PlatformBridge, VideoJob as VideoJobType, VideoOptions, PickedFile } from "../src/platform/types.ts";
// @ts-expect-error 素の JS を Electron と共有している
import { VideoJob } from "../shared/video-encoder.mjs";

const require = createRequire(import.meta.url);

export function ffmpegBinary(): string {
  try {
    const p = require("ffmpeg-static");
    if (typeof p === "string") return p;
  } catch { /* PATH を試す */ }
  return "ffmpeg";
}

export class NodeBridge implements PlatformBridge {
  readonly name = "electron" as const;
  readonly canExportVideo = true;
  private outPath: string;
  constructor(outPath: string) { this.outPath = outPath; }

  async openFile(): Promise<PickedFile | null> { return null; }
  async saveFile(): Promise<string | null> { return null; }
  async loadSettings(): Promise<Record<string, unknown>> { return {}; }
  async saveSettings(): Promise<void> {}
  async videoBackend(): Promise<string | null> { return ffmpegBinary(); }

  async startVideo(opts: VideoOptions): Promise<VideoJobType> {
    const job = new VideoJob(ffmpegBinary(), opts, this.outPath);
    return {
      id: "test",
      write: (video: Uint8Array | null, audio: Int16Array | null) =>
        job.write(
          video ? Buffer.from(video) : null,
          // **必ず複製する。** 渡ってくるのは使い回しバッファのビューで、
          // 書き込みが同期的に返ると、中身が読まれる前に次のフレームで
          // 上書きされる。Electron 側の実装は slice() 済み。
          audio ? Buffer.copyBytesFrom(audio) : null,
        ),
      finish: () => job.finish(),
      cancel: () => job.cancel(),
    };
  }
}

export function ffprobe(path: string): Promise<Record<string, unknown>> {
  // ffmpeg-static には ffprobe が付いてこないので、PATH のものを使う。
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", path]);
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve(JSON.parse(out)) : reject(new Error(`ffprobe exit ${c}`))));
  });
}

/** 音量を測る。音声ストリームがあるのに無音、という事故を捕まえるため。 */
export function measureVolume(path: string): Promise<{ mean: number; max: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBinary(), ["-v", "info", "-i", path, "-af", "volumedetect", "-f", "null", "-"]);
    let err = "";
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", () => {
      const mean = Number(err.match(/mean_volume:\s*(-?[\d.]+)/)?.[1] ?? NaN);
      const max = Number(err.match(/max_volume:\s*(-?[\d.]+)/)?.[1] ?? NaN);
      if (Number.isNaN(mean) || Number.isNaN(max)) reject(new Error(`音量を読み取れません\n${err.slice(-500)}`));
      else resolve({ mean, max });
    });
  });
}
