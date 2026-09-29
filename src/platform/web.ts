/** ブラウザ実装。Electron が無いときの受け皿。
 *
 *  ファイル保存はダウンロード、設定は localStorage。動画書き出しは持たない
 *  (WebCodecs での実装は将来の課題として docs/roadmap.md に置く)。 */

import type { PickedFile, PlatformBridge, VideoJob, VideoOptions } from "./types.ts";

const ACCEPT: Record<string, string> = {
  rom: ".nes,.NES",
  recording: ".rnes",
  state: ".state",
};

export class WebBridge implements PlatformBridge {
  readonly name = "web" as const;
  readonly canExportVideo = false;

  openFile(kind: "rom" | "recording" | "state"): Promise<PickedFile | null> {
    return new Promise((resolve) => {
      const el = document.createElement("input");
      el.type = "file";
      el.accept = ACCEPT[kind] ?? "";
      el.onchange = async () => {
        const f = el.files?.[0];
        if (!f) return resolve(null);
        resolve({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      };
      el.oncancel = () => resolve(null);
      el.click();
    });
  }

  async saveFile(_kind: string, suggestedName: string, bytes: Uint8Array): Promise<string | null> {
    const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return suggestedName;
  }

  async loadSettings(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(localStorage.getItem("recordnes:settings") ?? "{}");
    } catch {
      return {};
    }
  }

  async saveSettings(v: Record<string, unknown>): Promise<void> {
    localStorage.setItem("recordnes:settings", JSON.stringify(v));
  }

  async startVideo(_opts: VideoOptions): Promise<VideoJob> {
    throw new Error("ブラウザ版では動画書き出しに対応していません。デスクトップ版をお使いください。");
  }

  async videoBackend(): Promise<string | null> {
    return null;
  }
}
