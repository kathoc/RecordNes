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
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { VideoJob } from "../shared/video-encoder.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const isDev = !app.isPackaged && process.env.RECORDNES_DEV === "1";

app.commandLine.appendSwitch("disable-gpu-vsync");
app.commandLine.appendSwitch("disable-frame-rate-limit");

let win = null;

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

  // renderer 側の console を main の標準出力へ出す。自動検証で中を見る唯一の窓。
  win.webContents.on("console-message", (_e, level, message, line, source) => {
    const tag = ["log", "warn", "error", "info"][level] ?? level;
    console.log(`[renderer:${tag}] ${message} (${String(source).split("/").pop()}:${line})`);
  });

  win.webContents.on("did-finish-load", async () => {
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
  const r = await dialog.showSaveDialog(win, {
    defaultPath: opts.path || "recordnes.mp4",
    filters: [{ name: "MP4 動画", extensions: ["mp4"] }],
  });
  if (r.canceled || !r.filePath) throw new Error("書き出しを取りやめました");
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(id, new VideoJob(ffmpegPath(), opts, r.filePath));
  return { id };
});

ipcMain.handle("video:write", async (_e, id, video, audio) => {
  const job = jobs.get(id);
  if (!job) throw new Error("書き出しの作業が見つかりません");
  await job.write(Buffer.from(video), audio ? Buffer.from(audio) : null);
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
