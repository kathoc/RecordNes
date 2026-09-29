/** 操作の語彙。キーボードもコントローラーも、最後はここへ落ちる。 */

export type HeldCommand = "rewind" | "fastForward";

export type EdgeCommand =
  | "frameAdvance"
  | "pauseToggle"
  | "speedUp"
  | "speedDown"
  | "saveState"
  | "loadState"
  | "saveStateFile"
  | "loadStateFile"
  | "reset"
  | "saveRecording"
  | "marker"
  | "turboCycle"
  | "waysToggle"
  | "playFromStart"
  | "takeover";

export type Command = HeldCommand | EdgeCommand;

export const COMMAND_LABEL: Record<Command, string> = {
  rewind: "巻き戻し",
  fastForward: "早送り",
  frameAdvance: "コマ送り",
  pauseToggle: "一時停止 / 再開",
  speedUp: "速度を上げる",
  speedDown: "速度を下げる",
  saveState: "今の地点を覚える",
  loadState: "覚えた地点へ戻る",
  saveStateFile: "ステートをファイルへ保存",
  loadStateFile: "ステートをファイルから読み込み",
  reset: "リセット",
  saveRecording: "記録を保存",
  marker: "目印を打つ",
  turboCycle: "連射モード切替",
  waysToggle: "4-way / 8-way 切替",
  playFromStart: "最初から再生",
  takeover: "ここから自分でプレイ",
};

/** 1 フレーム分の入力の採取結果。 */
export interface InputSnapshot {
  /** NES へ渡す 1 バイト × 2 人分 */
  pads: [number, number];
  /** 押し続けている操作 */
  held: Set<HeldCommand>;
  /** このフレームで立ち上がった操作 */
  edges: EdgeCommand[];
  /** 何かしらのボタンに触れたか。再生中の引き継ぎ判定に使う */
  touched: boolean;
}
