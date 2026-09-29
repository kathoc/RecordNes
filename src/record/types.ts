/** 記録のデータモデル。
 *
 *  タイムラインは「フレーム番号を添字とする入力の配列」。`input[f]` は
 *  「f フレーム目の状態から f+1 フレーム目へ進めるときに入れた入力」。
 *  したがってフレーム数 n の記録は input[0..n-1] を持つ。 */

import type { RomInfo } from "../core/romid.ts";

export type EventType =
  /** リセットボタン。このフレームの直後にリセットが入る */
  | "reset"
  /** 頭出し用の目印。再現には影響しない */
  | "marker";

export interface TimelineEvent {
  /** 何フレーム進んだ時点の出来事か */
  frame: number;
  type: EventType;
  label?: string;
}

export interface Keyframe {
  frame: number;
  state: Uint8Array;
}

export type Origin =
  /** 電源投入から始まる。完全に再現できる */
  | "power"
  /** 外部のステートから始まる。そのステートをファイルに同梱する */
  | "savestate";

export interface RecordingMeta {
  version: number;
  createdAt: string;
  updatedAt: string;
  title: string;
  rom: RomInfo;
  players: 1 | 2;
  origin: Origin;
  frameCount: number;
  /** 参考情報。巻き戻した回数と、捨てたフレームの総数 */
  rewinds: number;
  discardedFrames: number;
  /** 記録中に使った最長のスロー段と最大のラン・アヘッド段。再現には使わない */
  notes?: Record<string, unknown>;
}

export const FORMAT_VERSION = 1;
export const MAGIC = "RNES";
