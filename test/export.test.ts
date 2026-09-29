import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMB, haveRom, newSession, scriptedInput } from "./helpers.ts";
import { Exporter, scaleNearest } from "../src/export/exporter.ts";
import { SCREEN_H, SCREEN_W } from "../src/core/emu.ts";
import { NodeBridge, ffprobe, measureVolume } from "./node-bridge.ts";

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

test("フレームレートを変えても、動画の長さが実時間と一致する", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const dir = mkdtempSync(join(tmpdir(), "recordnes-fps-"));
  const s = await newSession(SMB, 0);
  const script = scriptedInput(31);
  const FRAMES = 361; // NES の 6.005 秒ぶん
  for (let f = 0; f < FRAMES; f++) s.step(script(f));
  const realSeconds = FRAMES / 60.0978;

  for (const fps of [60, 59.94, 30]) {
    const out = join(dir, `fps-${fps}.mp4`);
    await new Exporter().run(
      new NodeBridge(out), s.romData()!, s.rec!,
      { from: 0, to: FRAMES },
      { scale: 1, fps, crf: 26, audio: true, overlayInput: false },
      () => {}, "fps.mp4",
    );
    const info = await ffprobe(out);
    const streams = info.streams as Record<string, unknown>[];
    const video = streams.find((x) => x.codec_type === "video")!;
    const audio = streams.find((x) => x.codec_type === "audio")!;
    const dur = Number((info.format as Record<string, unknown>).duration);
    assert.ok(
      Math.abs(dur - realSeconds) < 0.08,
      `${fps}fps: 長さ ${dur.toFixed(3)} 秒（実時間 ${realSeconds.toFixed(3)} 秒）`,
    );
    const expectedFrames = Math.ceil((FRAMES * fps) / 60.0978);
    const actual = Number(video.nb_frames ?? expectedFrames);
    assert.equal(actual, expectedFrames, `${fps}fps: 枚数`);
    const adur = Number(audio.duration ?? dur);
    assert.ok(Math.abs(adur - dur) < 0.08, `${fps}fps: 映像 ${dur} 秒 と 音声 ${adur} 秒 のずれ`);
  }
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
  // NES は 60.0978fps なので、60fps の動画では 300 エミュレートフレームが 299 枚になる。
  const expectedFrames = Math.ceil((FRAMES * 60) / 60.0978);
  assert.equal(Number(video.nb_frames ?? expectedFrames), expectedFrames, "動画の枚数");
  assert.equal(video.r_frame_rate, "60/1");
  assert.ok(audio, "音声ストリームがある");
  assert.equal(audio.codec_name, "aac");

  // 映像と音声の長さが揃っていること。ここがずれると動画として使えない。
  const dur = Number((info.format as Record<string, unknown>).duration);
  const expected = FRAMES / 60.0978; // 実時間
  assert.ok(Math.abs(dur - expected) < 0.06, `長さ ${dur} 秒 (実時間 ${expected} 秒)`);
  const vdur = Number(video.duration ?? dur);
  const adur = Number(audio.duration ?? dur);
  assert.ok(Math.abs(vdur - adur) < 0.06, `映像 ${vdur} 秒 と 音声 ${adur} 秒 のずれ`);

  // 音声ストリームがあるだけでは足りない。無音のまま書き出していないか確かめる。
  const vol = await measureVolume(out);
  assert.ok(vol.max > -20, `最大音量 ${vol.max} dB（無音なら -91 付近）`);
  assert.ok(vol.mean > -45, `平均音量 ${vol.mean} dB`);
});
