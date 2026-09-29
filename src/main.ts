// コアより先に読み込む。console.error を包んで CPU 停止を捕まえるため。
import "./core/jam-watch.ts";
import { App } from "./ui/app.ts";
import { WebBridge } from "./platform/web.ts";
import * as recordFormat from "./record/format.ts";
import * as recordExport from "./export/exporter.ts";
import { ElectronBridge, detectBridge } from "./platform/electron.ts";

const api = detectBridge();
const bridge = api ? new ElectronBridge(api) : new WebBridge();
const app = new App(bridge);
void app.start().then(() => {
  // 起動時に渡されたファイルを開く (`electron . game.nes`、OS の関連付け)。
  if (bridge instanceof ElectronBridge) {
    bridge.onBootFile((f) => {
      if (f.name.toLowerCase().endsWith(".rnes")) void app.openRecordingBytes(f.bytes);
      else void app.loadRomBytes(f.bytes, f.name);
    });
  }
});

// 開発と自動検証のために出しておく。実アプリをそのまま動かして確かめる入口。
(window as unknown as { recordnesApp: App }).recordnesApp = app;
(window as unknown as { recordnesFormat: typeof recordFormat }).recordnesFormat = recordFormat;
(window as unknown as { recordnesExport: typeof recordExport }).recordnesExport = recordExport;
