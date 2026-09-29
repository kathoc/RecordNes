/** ネイティブ機能の境界。
 *
 *  `src/` の他の場所は、ファイル選択も保存も ffmpeg 起動も、すべてこの
 *  インターフェース越しにしか触らない。Android 対応のときに書き換える場所を
 *  ここ 1 つに閉じ込めるため。 */

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
  /** 上書き保存に使える場所を指せるなら入れる (Electron のパスなど) */
  path?: string;
}

export interface VideoOptions {
  /** 出力ファイルのパス。null なら実装側が尋ねる */
  path?: string | null;
  width: number;
  height: number;
  /** 60000/1001 か 60 */
  fps: number;
  sampleRate: number;
  /** H.264 の品質 (CRF)。小さいほど高画質 */
  crf: number;
  /** 音声を入れるか */
  audio: boolean;
}

export interface VideoJob {
  id: string;
  /** RGBA の 1 フレーム (width*height*4) と、そのフレーム分の音声サンプル */
  write(video: Uint8Array, audio: Int16Array | null): Promise<void>;
  finish(): Promise<string>;
  cancel(): Promise<void>;
}

export interface PlatformBridge {
  readonly name: "electron" | "web";
  /** 動画書き出しができるか */
  readonly canExportVideo: boolean;

  openFile(kind: "rom" | "recording" | "state"): Promise<PickedFile | null>;
  saveFile(kind: "recording" | "state" | "sram", suggestedName: string, bytes: Uint8Array): Promise<string | null>;
  /** 設定の保存先。Electron では userData、web では localStorage */
  loadSettings(): Promise<Record<string, unknown>>;
  saveSettings(v: Record<string, unknown>): Promise<void>;

  startVideo(opts: VideoOptions): Promise<VideoJob>;
  /** ffmpeg の場所と版。無ければ null */
  videoBackend(): Promise<string | null>;
}
