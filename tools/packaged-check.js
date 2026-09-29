// 配布物（AppImage）の中で動かす検証。asar 内の preload、展開された ffmpeg、
// 実際の書き出しまでを、製品そのもので確かめる。
const app = window.recordnesApp;
const s = app.session;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const check = (name, ok, detail) => log.push({ name, ok: !!ok, detail });

for (let i = 0; i < 100 && !s.rec; i++) await sleep(100);
check("ROM が読み込まれ記録が始まる", !!s.rec && s.frame > 0, { frame: s.frame });
check("Electron の橋がつながっている", !!window.recordnes, {});

const backend = await window.recordnes.videoBackend();
check("同梱の ffmpeg が起動できる", !!backend, { backend });

// START を押してゲームを進め、そのまま書き出す。
window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
await sleep(150);
window.dispatchEvent(new KeyboardEvent("keyup", { code: "Enter" }));
await sleep(2500);
app.setPaused(true);
await sleep(100);

const exp = await import_exporter();
async function import_exporter() { return window.recordnesExport; }
const frames = Math.min(180, s.totalFrames);
let lastProgress = null;
const path = await new exp.Exporter().run(
  app.bridge, s.romData(), s.rec, { from: 0, to: frames },
  { scale: 2, fps: 60, crf: 24, audio: true, overlayInput: false },
  (p) => { lastProgress = p; }, "packaged.mp4",
);
check("配布物から mp4 を書き出せる", !!path, { path, frames, lastProgress });

return { ok: log.every((x) => x.ok), log };
