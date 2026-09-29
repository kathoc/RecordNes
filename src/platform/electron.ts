/** Electron 実装。preload が渡す `window.recordnes` を通す。 */

import type { PickedFile, PlatformBridge, VideoJob, VideoOptions } from "./types.ts";

export interface ElectronApi {
  openFile(kind: string): Promise<{ name: string; bytes: ArrayBuffer; path: string } | null>;
  saveFile(kind: string, suggestedName: string, bytes: ArrayBuffer): Promise<string | null>;
  loadSettings(): Promise<Record<string, unknown>>;
  saveSettings(v: Record<string, unknown>): Promise<void>;
  videoStart(opts: VideoOptions): Promise<{ id: string }>;
  videoWrite(id: string, video: ArrayBuffer | null, audio: ArrayBuffer | null): Promise<void>;
  videoFinish(id: string): Promise<string>;
  videoCancel(id: string): Promise<void>;
  videoBackend(): Promise<string | null>;
  onBootFile(cb: (f: { name: string; path: string; bytes: ArrayBuffer }) => void): void;
}

declare global {
  interface Window {
    recordnes?: ElectronApi;
  }
}

export class ElectronBridge implements PlatformBridge {
  readonly name = "electron" as const;
  readonly canExportVideo = true;
  private api: ElectronApi;

  constructor(api: ElectronApi) {
    this.api = api;
  }

  async openFile(kind: "rom" | "recording" | "state"): Promise<PickedFile | null> {
    const r = await this.api.openFile(kind);
    return r ? { name: r.name, bytes: new Uint8Array(r.bytes), path: r.path } : null;
  }

  saveFile(kind: string, suggestedName: string, bytes: Uint8Array): Promise<string | null> {
    const copy = bytes.slice();
    return this.api.saveFile(kind, suggestedName, copy.buffer as ArrayBuffer);
  }

  loadSettings(): Promise<Record<string, unknown>> {
    return this.api.loadSettings();
  }

  saveSettings(v: Record<string, unknown>): Promise<void> {
    return this.api.saveSettings(v);
  }

  async startVideo(opts: VideoOptions): Promise<VideoJob> {
    const { id } = await this.api.videoStart(opts);
    const api = this.api;
    return {
      id,
      async write(video: Uint8Array | null, audio: Int16Array | null) {
        const v = video ? video.slice() : null;
        const a = audio ? audio.slice() : null;
        await api.videoWrite(
          id,
          v ? (v.buffer as ArrayBuffer) : null,
          a ? (a.buffer as ArrayBuffer) : null,
        );
      },
      finish: () => api.videoFinish(id),
      cancel: () => api.videoCancel(id),
    };
  }

  videoBackend(): Promise<string | null> {
    return this.api.videoBackend();
  }

  /** 起動時に渡されたファイル。コマンドライン引数や「このアプリで開く」から来る。 */
  onBootFile(cb: (f: { name: string; bytes: Uint8Array }) => void): void {
    this.api.onBootFile?.((f) => cb({ name: f.name, bytes: new Uint8Array(f.bytes) }));
  }
}

export function detectBridge(): ElectronApi | null {
  return typeof window !== "undefined" && window.recordnes ? window.recordnes : null;
}
