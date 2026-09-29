/** Electron の main。
 *
 *  やることは 3 つだけ。ウィンドウを出す、ファイルダイアログを出す、ffmpeg を回す。
 *  描画もエミュレートも renderer 側にある。
 *
 *  遅延のために、GPU の vsync 待ちとフレームレート制限を外している。
 *  画面の更新を合成器の都合で待たされると、それがそのまま入力遅延になる。 */

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { VideoJob } from "../shared/video-encoder.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const isDev = !app.isPackaged && process.env.RECORDNES_DEV === "1";

/** 自動検証。`RECORDNES_SELFTEST=<script.js>` を付けて起動すると、そのスクリプトを
 *  画面の中で走らせ、結果を `RECORDNES_SELFTEST_OUT` へ書いて終了する。
 *  実際のアプリを実際のループで動かしたまま確かめるための唯一の入口。 */
const selfTest = process.env.RECORDNES_SELFTEST ?? "";

/** フレーム制限の解除。
 *
 *  外すと rAF が画面の更新間隔に縛られず、入力を採ってからエミュレートするまでが
 *  最短になる。代わりに rAF が数百 Hz で回って CPU を食う。既定は切っておき、
 *  遅延を最優先したい人だけが入れる。切り替えは起動時にしか効かない。 */
function readSettingsSync() {
  try {
    return JSON.parse(readFileSync(path.join(app.getPath("userData"), "settings.json"), "utf8"));
  } catch {
    return {};
  }
}
if (process.env.RECORDNES_UNCAP === "1" || readSettingsSync().uncapFrameRate) {
  app.commandLine.appendSwitch("disable-gpu-vsync");
  app.commandLine.appendSwitch("disable-frame-rate-limit");
}

let win = null;
/** 閉じてよいと決まったあと。二重に尋ねない */
let closing = false;

/** 起動時に開くファイル。コマンドライン引数か、OS の「このアプリで開く」から来る。
 *  自動検証でも使う: `electron . path/to/game.nes` で ROM を読んだ状態から始まる。 */
function bootFiles() {
  return process.argv.slice(1).filter((a) => /\.(nes|rnes)$/i.test(a));
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 900,
    backgroundColor: "#12131a",
    title: "RecordNes",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);

  // **未保存の確認は main 側で出す。**
  // renderer の beforeunload の中で confirm() を呼んでも、Chromium が
  // `Blocked confirm(...) during beforeunload` として握りつぶす。
  // 画面には何も出ないまま「保存しない」を選んだ扱いになり、記録が黙って消えた。
  win.on("close", (e) => {
    if (closing) return;
    e.preventDefault();
    void askBeforeClose();
  });

  // renderer 側の console を main の標準出力へ出す。自動検証で中を見る唯一の窓。
  win.webContents.on("console-message", (_e, level, message, line, source) => {
    const tag = ["log", "warn", "error", "info"][level] ?? level;
    console.log(`[renderer:${tag}] ${message} (${String(source).split("/").pop()}:${line})`);
  });

  // 自動検証用。指定秒後に、利用者が閉じたのと同じ経路で閉じにいく。
  if (process.env.RECORDNES_CLOSE_AFTER) {
    setTimeout(() => {
      console.log("[close] 閉じる操作を送ります");
      win.close();
    }, Number(process.env.RECORDNES_CLOSE_AFTER) * 1000);
  }

  win.webContents.on("did-finish-load", async () => {
    if (selfTest) void runSelfTest();
    for (const p of bootFiles()) {
      try {
        const buf = await readFile(p);
        win.webContents.send("boot:file", {
          name: path.basename(p),
          path: p,
          bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        });
      } catch (err) {
        console.error(`起動時に ${p} を開けませんでした:`, err.message);
      }
    }
  });
  if (isDev) {
    await win.loadURL(process.env.RECORDNES_URL ?? "http://localhost:5173/");
  } else {
    await win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

/** 画面の写真を撮る。自動検証から呼ぶ。 */
ipcMain.handle("shot", async (_e, name) => {
  const img = await win.webContents.capturePage();
  const out = path.join(process.env.RECORDNES_SHOT_DIR ?? app.getPath("temp"), `${name}.png`);
  await writeFile(out, img.toPNG());
  return out;
});

async function askBeforeClose() {
  let unsaved = false;
  try {
    unsaved = await win.webContents.executeJavaScript(
      "Boolean(window.recordnesApp && window.recordnesApp.hasUnsavedWork && window.recordnesApp.hasUnsavedWork())",
      true,
    );
  } catch { /* 画面が応答しないなら、止めずに閉じる */ }

  if (unsaved) {
    console.log("[close] 未保存の記録があるので確認を出します");
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["保存して閉じる", "保存せずに閉じる", "やめる"],
      defaultId: 0,
      cancelId: 2,
      message: "記録がまだ保存されていません",
      detail: "閉じると、この記録は失われます。",
    });
    if (response === 2) return;
    if (response === 0) {
      const saved = await win.webContents
        .executeJavaScript("window.recordnesApp.saveRecordingForClose()", true)
        .catch(() => false);
      if (!saved) return; // 保存を取りやめたなら閉じない
    }
  }
  console.log("[close] 閉じます");
  closing = true;
  win.close();
}

async function runSelfTest() {
  const script = await readFile(selfTest, "utf8");
  let result;
  try {
    result = await win.webContents.executeJavaScript(`(async () => { ${script} })()`, true);
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  const out = process.env.RECORDNES_SELFTEST_OUT;
  const text = JSON.stringify(result, null, 2);
  if (out) await writeFile(out, text);
  console.log(`[selftest] ${text}`);
  closing = true;   // 自動検証では未保存の確認を出さない
  app.quit();
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

const FILTERS = {
  rom: [{ name: "NES ROM", extensions: ["nes", "NES"] }],
  recording: [{ name: "RecordNes の記録", extensions: ["rnes"] }],
  state: [{ name: "ステートセーブ", extensions: ["state"] }],
  sram: [{ name: "セーブデータ", extensions: ["sav"] }],
};

ipcMain.handle("file:open", async (_e, kind) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: FILTERS[kind] ?? [],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  const p = r.filePaths[0];
  const buf = await readFile(p);
  return { name: path.basename(p), path: p, bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
});

ipcMain.handle("file:save", async (_e, kind, suggestedName, bytes) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName,
    filters: FILTERS[kind] ?? [],
  });
  if (r.canceled || !r.filePath) return null;
  await writeFile(r.filePath, Buffer.from(bytes));
  return r.filePath;
});

ipcMain.handle("settings:load", async () => {
  try {
    return JSON.parse(await readFile(settingsPath(), "utf8"));
  } catch {
    return {};
  }
});

ipcMain.handle("settings:save", async (_e, v) => {
  await mkdir(path.dirname(settingsPath()), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(v, null, 2));
});

/** ffmpeg の場所。同梱版を優先し、無ければ PATH。 */
function ffmpegPath() {
  try {
    let p = require("ffmpeg-static");
    if (typeof p === "string") {
      // asar の中にある実行ファイルは起動できないので、展開先を見る。
      p = p.replace("app.asar", "app.asar.unpacked");
      if (existsSync(p)) return p;
    }
  } catch { /* 同梱が無ければ PATH を試す */ }
  return "ffmpeg";
}

ipcMain.handle("video:backend", async () => {
  const bin = ffmpegPath();
  return await new Promise((resolve) => {
    const p = spawn(bin, ["-version"]);
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("error", (err) => { console.error(`ffmpeg を起動できません (${bin}):`, err.message); resolve(null); });
    p.on("close", (code) => {
      if (code !== 0) console.error(`ffmpeg -version が異常終了 (${bin}, code ${code})`);
      resolve(code === 0 ? `${bin.split("/").pop()} ${out.match(/ffmpeg version (\S+)/)?.[1] ?? ""}`.trim() : null);
    });
  });
});

const jobs = new Map();

ipcMain.handle("video:start", async (_e, opts) => {
  // 自動検証では保存ダイアログを出せない。出力先を環境変数で渡せるようにする。
  let filePath = process.env.RECORDNES_VIDEO_OUT ?? "";
  if (!filePath) {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: opts.path || "recordnes.mp4",
      filters: [{ name: "MP4 動画", extensions: ["mp4"] }],
    });
    if (r.canceled || !r.filePath) throw new Error("書き出しを取りやめました");
    filePath = r.filePath;
  }
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(id, new VideoJob(ffmpegPath(), opts, filePath));
  return { id };
});

ipcMain.handle("video:write", async (_e, id, video, audio) => {
  const job = jobs.get(id);
  if (!job) throw new Error("書き出しの作業が見つかりません");
  await job.write(video ? Buffer.from(video) : null, audio ? Buffer.from(audio) : null);
});

ipcMain.handle("video:finish", async (_e, id) => {
  const job = jobs.get(id);
  if (!job) throw new Error("書き出しの作業が見つかりません");
  try {
    return await job.finish();
  } finally {
    jobs.delete(id);
  }
});

ipcMain.handle("video:cancel", async (_e, id) => {
  const job = jobs.get(id);
  if (!job) return;
  await job.cancel();
  jobs.delete(id);
});
