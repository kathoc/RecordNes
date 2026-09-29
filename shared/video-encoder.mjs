/** mp4 への書き出し。Electron の main とテストの両方から使う。
 *
 *  ## なぜ二段なのか（2026-09-29 の調査）
 *
 *  最初は映像を fd 3、音声を fd 4 の 2 本のパイプで同時に流す作りにした。
 *  2 フレーム目で必ず止まった。
 *
 *  理由。ffmpeg は多重化のために、タイムスタンプが遅れている方の入力から読む。
 *  映像 1 フレーム (512×480 で 983KB) を読み終えると、次は音声を求める。ところが
 *  音声は生の PCM を 1KB 単位で読むので、1 フレーム分 (1600 バイト) では足りず、
 *  続きを待つ。こちらは次の映像フレームをパイプへ書こうとして、64KB のパイプが
 *  一杯なので待つ。互いに相手を待って止まる。
 *
 *  **音声を 1 秒ぶん先に流し込むと通る**ことを確かめた (tools/pipe-probe.mjs)。
 *  しかし映像と音声は同じエミュレーションから同時に出てくるので、音声だけ先に
 *  作ることはできない。
 *
 *  そこでパイプを 1 本に減らした。
 *
 *    第 1 段: 映像をパイプで渡して H.264 に符号化。音声は生のまま一時ファイルへ書く
 *    第 2 段: 一時ファイル同士を多重化する。映像は `-c:v copy` で再符号化しない
 *
 *  待ち合わせる相手がいなくなるので、原理的に止まらない。第 2 段は再符号化が無く、
 *  5 分の動画でも 1 秒前後で終わる。音ズレは、1 フレームあたりの音声本数を
 *  目標 fps ちょうどに合わせてあるので、ここでも生じない。 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { rm, rename } from "node:fs/promises";
import { once } from "node:events";

/** 第 1 段: 生の RGBA をパイプから受けて H.264 にする。 */
export function videoPassArgs(opts, outPath) {
  return [
    "-y",
    "-probesize", "32", "-analyzeduration", "0",
    "-f", "rawvideo", "-pix_fmt", "rgba",
    "-s", `${opts.width}x${opts.height}`,
    "-r", String(opts.fps),
    "-i", "pipe:3",
    "-an",
    "-c:v", "libx264", "-preset", opts.preset ?? "medium", "-crf", String(opts.crf),
    "-pix_fmt", "yuv420p",
    outPath,
  ];
}

/** 第 2 段: 映像はそのまま、音声だけ符号化して 1 つの mp4 にまとめる。 */
export function muxPassArgs(opts, videoPath, pcmPath, outPath) {
  return [
    "-y",
    "-i", videoPath,
    "-f", "s16le", "-ar", String(opts.sampleRate), "-ac", "1", "-i", pcmPath,
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", String(opts.audioBitrate ?? "192k"), "-ac", "2",
    "-shortest", "-movflags", "+faststart",
    outPath,
  ];
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; if (err.length > 40000) err = err.slice(-20000); });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(err) : reject(new Error(`ffmpeg が異常終了しました (コード ${code})\n${err.slice(-1500)}`)));
  });
}

async function writeTo(stream, buf) {
  if (!stream || stream.destroyed) throw new Error("書き込み先が閉じています");
  if (!stream.write(buf)) await once(stream, "drain");
}

/** 書き出し 1 件。`write` をフレームごとに呼び、最後に `finish`。 */
export class VideoJob {
  constructor(ffmpegBin, opts, outPath) {
    this.bin = ffmpegBin;
    this.opts = opts;
    this.out = outPath;
    this.videoTmp = `${outPath}.video.tmp.mp4`;
    this.pcmTmp = `${outPath}.audio.tmp.pcm`;
    this.child = spawn(ffmpegBin, videoPassArgs(opts, this.videoTmp), {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    this.stderr = "";
    this.child.stderr.on("data", (d) => {
      this.stderr += d;
      if (this.stderr.length > 40000) this.stderr = this.stderr.slice(-20000);
    });
    this.failed = null;
    this.child.on("error", (e) => { this.failed = e; });
    this.pcm = opts.audio ? createWriteStream(this.pcmTmp) : null;
    this.frames = 0;
  }

  async write(video, audio) {
    if (this.failed) throw this.failed;
    // 音声はファイルへ書くので、映像の詰まりに巻き込まれない。
    const jobs = [writeTo(this.child.stdio[3], video)];
    if (this.pcm && audio && audio.length) jobs.push(writeTo(this.pcm, audio));
    await Promise.all(jobs);
    this.frames++;
  }

  async finish() {
    this.child.stdio[3]?.end();
    const [code] = await once(this.child, "close");
    if (code !== 0) {
      await this.cleanup();
      throw new Error(`映像の符号化が異常終了しました (コード ${code})\n${this.stderr.slice(-1500)}`);
    }
    if (this.pcm) {
      this.pcm.end();
      await once(this.pcm, "close");
      await run(this.bin, muxPassArgs(this.opts, this.videoTmp, this.pcmTmp, this.out));
      await this.cleanup();
    } else {
      await rename(this.videoTmp, this.out);
    }
    return this.out;
  }

  async cancel() {
    try { this.child.kill("SIGKILL"); } catch { /* すでに終わっている */ }
    this.pcm?.destroy();
    await this.cleanup();
  }

  async cleanup() {
    await rm(this.videoTmp, { force: true }).catch(() => {});
    await rm(this.pcmTmp, { force: true }).catch(() => {});
  }
}
