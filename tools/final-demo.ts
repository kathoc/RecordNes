/** 完成の条件（docs/spec.md 8章）を、一本の流れで通して確かめる。
 *  ここで作る mp4 が、このアプリの成果物そのもの。 */
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { newSession } from "../test/helpers.ts";
import { identifyRom } from "../src/core/romid.ts";
import { Session } from "../src/core/session.ts";
import { serialize, parseToRecorder } from "../src/record/format.ts";
import { Exporter } from "../src/export/exporter.ts";
import { NodeBridge } from "../test/node-bridge.ts";

const SMB = "/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES";
const out = "tmp/demo.mp4";

// 1. 遊ぶ。START を押して右へ走る。跳ばないので、そのうち穴に落ちる。
//    （ここで打つ入力は機械的な筋書きで、上手いプレイではない。
//      確かめたいのは「巻き戻して撮り直した跡が残らないこと」の方）
const s = await newSession(SMB, 1);
const play = (f: number): [number, number] => {
  if (f === 90 || f === 91) return [0b00001000, 0];
  if (f < 150) return [0, 0];
  return [0b10000000, 0];          // ずっと右。跳ばないので穴に落ちる
};
for (let f = 0; f < 800; f++) s.step(play(f));
console.log(`1. 800 フレーム遊んだ（跳ばずに走り続けて失敗する筋書き）`);

// 2. 失敗する手前まで巻き戻し、今度は跳びながら進み直す。
// 穴に落ちるより手前まで戻す。ここより後ろの「失敗」はすべて消える。
s.seek(380);
console.log(`2. 380 フレームまで巻き戻した（記録はまだ ${s.totalFrames} フレーム）`);
const better = (f: number): [number, number] => {
  let b = 0b10000000;
  if ((f % 40) < 12) b |= 0b00000001; // 跳ぶ
  return [b, 0];
};
for (let f = 380; f < 1100; f++) s.step(better(f));
console.log(`3. やり直して ${s.totalFrames} フレームになった（巻き戻し ${s.rec!.rewinds} 回、捨てた ${s.rec!.discardedFrames} フレーム）`);

// 3. 目印を打って保存する。
s.mark("やり直した地点のあたり");
const bytes = await serialize(s.rec!, s.emu.sram());
writeFileSync("tmp/demo.rnes", bytes);
console.log(`4. 記録を保存した: tmp/demo.rnes (${(bytes.length / 1024).toFixed(1)} KB)`);

// 4. 別のセッションで読み直し、続きから 200 フレーム足す。
const { rec } = await parseToRecorder(new Uint8Array(readFileSync("tmp/demo.rnes")));
const romBytes = new Uint8Array(readFileSync(SMB));
const info = await identifyRom(romBytes, "smb");
const day2 = new Session({ runAhead: 0 });
await day2.loadRom(romBytes, info, info.name);
await day2.adoptRecording(rec, "tail");
console.log(`5. 読み直して ${day2.frame} フレーム目から再開した`);
const resumeAt = day2.frame;   // ループ条件に day2.frame を使うと終わらない
for (let f = resumeAt; f < resumeAt + 200; f++) day2.step(better(f));
console.log(`6. 続きを記録して ${day2.totalFrames} フレームになった`);

// 5. 動画にする。
await new Exporter().run(
  new NodeBridge(out), day2.romData()!, day2.rec!,
  { from: 0, to: day2.totalFrames },
  { scale: 2, fps: 60, crf: 18, audio: true, overlayInput: false },
  (p) => { if (p.frame % 400 === 0) console.log(`   書き出し ${p.frame}/${p.total}`); },
  "demo.mp4",
);
const probe = spawnSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", out], { encoding: "utf8" });
const info2 = JSON.parse(probe.stdout);
const v = info2.streams.find((x: { codec_type: string }) => x.codec_type === "video");
const a = info2.streams.find((x: { codec_type: string }) => x.codec_type === "audio");
console.log(`7. mp4 を書き出した: ${out}`);
console.log(`   ${v.width}x${v.height} ${v.r_frame_rate} ${v.nb_frames} 枚 / 音声 ${a.codec_name} ${a.channels}ch / ${info2.format.duration} 秒 / ${(Number(info2.format.size) / 1024 / 1024).toFixed(2)} MB`);

// 6. 巻き戻した跡が残っていないことを、動画の中身で確かめる。
spawnSync("ffmpeg", ["-y", "-v", "quiet", "-i", out, "-vf", "select='eq(n\\,340)+eq(n\\,390)+eq(n\\,450)+eq(n\\,520)',tile=4x1,scale=iw/2:ih/2", "-frames:v", "1", "tmp/demo-frames.png"]);
console.log("8. 抜き出し: tmp/demo-frames.png（巻き戻した 380 フレーム目の前後を並べた）");
