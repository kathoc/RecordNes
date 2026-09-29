import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMB, haveRom, newSession } from "./helpers.ts";
import { Exporter } from "../src/export/exporter.ts";
import { Emu, SCREEN_H, SCREEN_W } from "../src/core/emu.ts";
import { NodeBridge, ffmpegBinary } from "./node-bridge.ts";

/** mp4 を rgb24 の生フレーム列へ戻す。 */
function decodeFrames(path: string, w: number, h: number): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBinary(), ["-v", "quiet", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    const chunks: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.on("error", reject);
    p.on("close", () => {
      const all = Buffer.concat(chunks);
      const size = w * h * 3;
      const out: Uint8Array[] = [];
      for (let o = 0; o + size <= all.length; o += size) out.push(new Uint8Array(all.subarray(o, o + size)));
      resolve(out);
    });
  });
}

/** RGBA を rgb24 に詰め直す。参照どうしを比べるときに使う。 */
function toRgb(rgba: Uint8Array): Uint8Array {
  const n = SCREEN_W * SCREEN_H;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = rgba[i * 4];
    out[i * 3 + 1] = rgba[i * 4 + 1];
    out[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return out;
}

/** RGBA の絵と rgb24 の絵の平均絶対差 (0-255)。 */
function meanAbsDiff(rgba: Uint8Array, rgb: Uint8Array): number {
  let sum = 0;
  const n = SCREEN_W * SCREEN_H;
  for (let i = 0; i < n; i++) {
    sum += Math.abs(rgba[i * 4] - rgb[i * 3]);
    sum += Math.abs(rgba[i * 4 + 1] - rgb[i * 3 + 1]);
    sum += Math.abs(rgba[i * 4 + 2] - rgb[i * 3 + 2]);
  }
  return sum / (n * 3);
}

test("書き出した動画の各フレームが、記録どおりの絵と順序になっている", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const dir = mkdtempSync(join(tmpdir(), "recordnes-fid-"));
  const out = join(dir, "fid.mp4");
  const FRAMES = 700;
  const play = (f: number): [number, number] => {
    if (f === 90 || f === 91) return [0b00001000, 0];
    if (f < 140) return [0, 0];
    return [0b10000000 | ((f % 48) < 14 ? 1 : 0), 0];
  };

  const s = await newSession(SMB, 0);
  for (let f = 0; f < FRAMES; f++) s.step(play(f));

  await new Exporter().run(
    new NodeBridge(out), s.romData()!, s.rec!,
    { from: 0, to: FRAMES },
    { scale: 1, fps: 60, crf: 12, audio: false, overlayInput: false },
    () => {}, "fid.mp4",
  );

  const decoded = await decodeFrames(out, SCREEN_W, SCREEN_H);
  assert.equal(decoded.length, FRAMES, "フレーム数が一致");

  // エミュレーターをもう一度回して、同じ位置の絵を作る。
  const emu = new Emu(48000);
  await emu.load(s.romData()!);
  emu.setSink(null);
  const reference: Uint8Array[] = [];
  for (let f = 0; f < FRAMES; f++) {
    emu.step(...s.rec!.inputAt(f));
    reference.push(emu.pixels.slice());
  }

  // 画面が動いている地点を選ぶ。タイトルや面の読み込み中は前後が同じ絵なので、
  // ずらしても差が出ず、この見方では何も確かめられない。
  const OFFSETS = [-8, -3, 3, 8];
  const moving: number[] = [];
  for (let i = 16; i < FRAMES - 16 && moving.length < 4; i += 7) {
    // ずらした先がどれも十分違う地点だけを選ぶ。1 つでも同じ絵だと、
    // 「自分の方が近い」が成り立ちようがない。
    const worst = Math.min(...OFFSETS.map((d) => meanAbsDiff(reference[i], toRgb(reference[i + d]))));
    if (worst > 4) moving.push(i);
  }
  assert.ok(moving.length >= 3, `動きのある地点が見つかる (${moving.length} 件)`);

  // 対角 (同じ番号どうし) が、前後にずらした組み合わせより必ず近いこと。
  // これが成り立てば、内容も順序も合っている。
  for (const i of moving) {
    const own = meanAbsDiff(reference[i], decoded[i]);
    assert.ok(own < 8, `frame ${i}: 自分との差 ${own.toFixed(2)} が小さい (H.264 の劣化分)`);
    for (const d of OFFSETS) {
      const j = i + d;
      if (j < 0 || j >= FRAMES) continue;
      const other = meanAbsDiff(reference[i], decoded[j]);
      assert.ok(own < other, `frame ${i}: 自分 ${own.toFixed(2)} < ${d} ずらし ${other.toFixed(2)}`);
    }
  }
});
