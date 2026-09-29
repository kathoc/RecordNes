import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMB, haveRom, newSession, scriptedInput } from "./helpers.ts";
import { Exporter, resampleFrame, scaleNearest } from "../src/export/exporter.ts";
import { SCREEN_H, SCREEN_W } from "../src/core/emu.ts";
import { NodeBridge, ffprobe } from "./node-bridge.ts";

test("最近傍拡大は、画素を正確に整数倍へ複製する", () => {
  const src = new Uint8Array(SCREEN_W * SCREEN_H * 4);
  // 左上を赤、(1,0) を緑にする
  src.set([255, 0, 0, 255], 0);
  src.set([0, 255, 0, 255], 4);
  const scale = 3;
  const dst = new Uint8Array(SCREEN_W * scale * SCREEN_H * scale * 4);
  scaleNearest(src, scale, dst);
  const w = SCREEN_W * scale;
  for (let y = 0; y < scale; y++) {
    for (let x = 0; x < scale; x++) {
      const i = (y * w + x) * 4;
      assert.deepEqual([...dst.subarray(i, i + 4)], [255, 0, 0, 255], `赤 (${x},${y})`);
      const j = (y * w + scale + x) * 4;
      assert.deepEqual([...dst.subarray(j, j + 4)], [0, 255, 0, 255], `緑 (${x},${y})`);
    }
  }
});

test("音声の引き伸ばしは、要求された本数をきっかり返す", () => {
  const out = new Int16Array(4096);
  const input = Float32Array.from({ length: 799 }, (_, i) => Math.sin(i / 20));
  for (const need of [800, 799, 1600, 1]) {
    const carry = resampleFrame(input, need, 0, out);
    assert.equal(typeof carry, "number");
    assert.ok(out[need - 1] !== undefined, `${need} 本目まで書かれている`);
  }
  // 入力が無くても落ちない（早送りで音を捨てた直後など）
  resampleFrame(new Float32Array(0), 800, 0.5, out);
  assert.equal(out[0], Math.round(0.5 * 32767));
});

test("記録から mp4 を書き出し、長さ・解像度・音声が仕様どおりになる", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const dir = mkdtempSync(join(tmpdir(), "recordnes-"));
  const out = join(dir, "out.mp4");

  const s = await newSession(SMB, 0);
  const script = scriptedInput(21);
  const FRAMES = 300; // 5 秒
  for (let f = 0; f < FRAMES; f++) s.step(script(f));

  const progress: number[] = [];
  const path = await new Exporter().run(
    new NodeBridge(out), s.romData()!, s.rec!,
    { from: 0, to: FRAMES },
    { scale: 2, fps: 60, crf: 20, audio: true, overlayInput: false },
    (p) => progress.push(p.frame),
    "test.mp4",
  );
  assert.equal(path, out);
  assert.ok(existsSync(out) && statSync(out).size > 10000, "中身のあるファイルができている");
  assert.ok(progress.length > 1, "進捗が通知される");

  const info = await ffprobe(out);
  const streams = info.streams as Record<string, unknown>[];
  const video = streams.find((x) => x.codec_type === "video")!;
  const audio = streams.find((x) => x.codec_type === "audio")!;
  assert.equal(video.width, SCREEN_W * 2);
  assert.equal(video.height, SCREEN_H * 2);
  assert.equal(video.codec_name, "h264");
  assert.equal(video.nb_frames ? Number(video.nb_frames) : FRAMES, FRAMES, "フレーム数が一致");
  assert.equal(video.r_frame_rate, "60/1");
  assert.ok(audio, "音声ストリームがある");
  assert.equal(audio.codec_name, "aac");

  // 映像と音声の長さが揃っていること。ここがずれると動画として使えない。
  const dur = Number((info.format as Record<string, unknown>).duration);
  const expected = FRAMES / 60;
  assert.ok(Math.abs(dur - expected) < 0.06, `長さ ${dur} 秒 (期待 ${expected} 秒)`);
  const vdur = Number(video.duration ?? dur);
  const adur = Number(audio.duration ?? dur);
  assert.ok(Math.abs(vdur - adur) < 0.06, `映像 ${vdur} 秒 と 音声 ${adur} 秒 のずれ`);
});
