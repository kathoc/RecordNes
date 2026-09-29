// preload は CommonJS で書く。Electron の preload は既定のサンドボックス下では
// ESM を読めず、`Cannot use import statement outside a module` で黙って失敗する。
// 失敗しても画面は出るので、window.recordnes が無いことに気づきにくい。
const { contextBridge, ipcRenderer } = require("electron");

// renderer が購読するより先に届いた起動ファイルを溜めておく。
// did-finish-load は、アプリの初期化が終わるより前に飛んでくる。
const bootQueue = [];
let bootHandler = null;
ipcRenderer.on("boot:file", (_e, f) => {
  if (bootHandler) bootHandler(f);
  else bootQueue.push(f);
});

contextBridge.exposeInMainWorld("recordnes", {
  openFile: (kind) => ipcRenderer.invoke("file:open", kind),
  saveFile: (kind, name, bytes) => ipcRenderer.invoke("file:save", kind, name, bytes),
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (v) => ipcRenderer.invoke("settings:save", v),
  videoStart: (opts) => ipcRenderer.invoke("video:start", opts),
  videoWrite: (id, video, audio) => ipcRenderer.invoke("video:write", id, video, audio),
  videoFinish: (id) => ipcRenderer.invoke("video:finish", id),
  videoCancel: (id) => ipcRenderer.invoke("video:cancel", id),
  videoBackend: () => ipcRenderer.invoke("video:backend"),
  shot: (name) => ipcRenderer.invoke("shot", name),
  onBootFile: (cb) => {
    bootHandler = cb;
    while (bootQueue.length) cb(bootQueue.shift());
  },
});
