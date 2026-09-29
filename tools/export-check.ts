/** 書き出した mp4 を目で確かめるための素材を作る。
 *  記録どおりの絵が出ているかは、数値ではなく画像で見ないと分からない。 */
import { spawnSync } from "node:child_process";
import { newSession } from "../test/helpers.ts";
import { SMB } from "../test/helpers.ts";
import { Exporter } from "../src/export/exporter.ts";
import { NodeBridge, ffprobe } from "../test/node-bridge.ts";

const FRAMES = 900;
const out = "tmp/check.mp4";
const s = await newSession(SMB, 0);
// START を押してゲームを始め、右へ走りながら跳ぶ。
const play = (f: number): [number, number] => {
  if (f === 90 || f === 91) return [0b00001000, 0];
  if (f < 140) return [0, 0];
  let b = 0b10000000;
  if ((f % 48) < 14) b |= 0b00000001;
  return [b, 0];
};
for (let f = 0; f < FRAMES; f++) s.step(play(f));
console.log(`記録 ${s.totalFrames} フレーム`);

await new Exporter().run(
  new NodeBridge(out), s.romData()!, s.rec!,
  { from: 0, to: FRAMES },
  { scale: 2, fps: 60, crf: 18, audio: true, overlayInput: false },
  (p) => { if (p.frame % 300 === 0) console.log(`  ${p.phase} ${p.frame}/${p.total}`); },
  "check.mp4",
);
const info = await ffprobe(out) as { format: Record<string, string>; streams: Record<string, string>[] };
console.log(`できた: ${out}  ${info.format.duration} 秒  ${(Number(info.format.size) / 1024 / 1024).toFixed(2)} MB`);
for (const st of info.streams) console.log(`  ${st.codec_type}: ${st.codec_name} ${st.width ?? ""}x${st.height ?? ""} ${st.r_frame_rate ?? st.sample_rate ?? ""}`);

// 3 枚抜き出して並べる。
spawnSync("ffmpeg", ["-y", "-i", out, "-vf", "select='eq(n\\,160)+eq(n\\,500)+eq(n\\,880)',tile=3x1", "-frames:v", "1", "tmp/check-frames.png"], { stdio: "ignore" });
console.log("抜き出し: tmp/check-frames.png");
