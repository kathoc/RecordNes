/** 記録の本体。
 *
 *  ROM を読み込んだ瞬間に生まれ、以後ずっと入力を書き足していく。止める操作は無い。
 *  ユーザーが「記録開始」を押し忘れて名プレイを失う事故を起こさないため。
 *
 *  巻き戻しはこのクラスでは「タイムラインを縮める」操作 (`truncate`) として表れる。
 *  捨てた区間は二度と戻らないので、保存された記録に巻き戻しの痕跡は残らない。 */

import type { RomInfo } from "../core/romid.ts";
import type { Keyframe, Origin, RecordingMeta, TimelineEvent } from "./types.ts";
import { FORMAT_VERSION } from "./types.ts";

/** 密リング: 直近この本数を毎フレーム保存する。60fps で 15 秒。 */
export const DENSE_FRAMES = 900;
/** 疎キーフレーム: この間隔でセッション全体に残す。60fps で 5 秒。 */
export const SPARSE_INTERVAL = 300;

export class Recorder {
  readonly rom: RomInfo;
  title: string;
  players: 1 | 2 = 1;
  origin: Origin;
  /** origin === "savestate" のときの開始状態 */
  originState: Uint8Array | null = null;
  readonly createdAt = new Date().toISOString();

  events: TimelineEvent[] = [];
  rewinds = 0;
  discardedFrames = 0;

  /** input[f*2] = P1, input[f*2+1] = P2 */
  private buf: Uint8Array;
  private n = 0;

  /** frame -> state。疎キーフレームは消さない。 */
  private sparse = new Map<number, Uint8Array>();
  /** 密リング。frame -> state。DENSE_FRAMES を超えたら古いものから捨てる。 */
  private dense = new Map<number, Uint8Array>();

  constructor(rom: RomInfo, title: string, origin: Origin = "power") {
    this.rom = rom;
    this.title = title;
    this.origin = origin;
    this.buf = new Uint8Array(2 * 60 * 60 * 2); // 2 分ぶんから始める
  }

  get frameCount(): number {
    return this.n;
  }

  /** 1 フレーム分の入力を書き足す。エミュレートした直後に必ず呼ぶ。 */
  push(p1: number, p2: number): void {
    if ((this.n + 1) * 2 > this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.n * 2] = p1 & 0xff;
    this.buf[this.n * 2 + 1] = p2 & 0xff;
    this.n++;
  }

  inputAt(frame: number): [number, number] {
    if (frame < 0 || frame >= this.n) return [0, 0];
    return [this.buf[frame * 2], this.buf[frame * 2 + 1]];
  }

  /** 入力列の生バイト列。保存とテスト用。 */
  inputBytes(): Uint8Array {
    return this.buf.subarray(0, this.n * 2);
  }

  /** エミュレートした直後の状態を預ける。密リングと、間隔が来ていれば疎にも入る。 */
  snapshot(frame: number, state: Uint8Array): void {
    if (this.poisoned.has(frame)) return;
    this.dense.set(frame, state);
    if (this.dense.size > DENSE_FRAMES) {
      // Map は挿入順を保つので、最古は最初のキー。
      const oldest = this.dense.keys().next().value as number;
      this.dense.delete(oldest);
    }
    if (frame % SPARSE_INTERVAL === 0) this.sparse.set(frame, state);
  }

  /** frame 以下で最も近い、復元できる地点。見つからなければ null (= 最初から)。 */
  nearestState(frame: number): Keyframe | null {
    if (this.dense.has(frame)) return { frame, state: this.dense.get(frame)! };
    let best = -1;
    for (const f of this.dense.keys()) if (f <= frame && f > best) best = f;
    if (best >= 0) return { frame: best, state: this.dense.get(best)! };
    for (const f of this.sparse.keys()) if (f <= frame && f > best) best = f;
    if (best >= 0) return { frame: best, state: this.sparse.get(best)! };
    return null;
  }

  /** タイムラインを frame まで縮める。巻き戻しと引き継ぎの唯一の入口。 */
  truncate(frame: number, countAsRewind = true): void {
    if (frame >= this.n) return;
    if (countAsRewind) {
      this.rewinds++;
      this.discardedFrames += this.n - frame;
    }
    this.n = Math.max(0, frame);
    this.events = this.events.filter((e) => e.frame <= this.n);
    for (const f of [...this.dense.keys()]) if (f > this.n) this.dense.delete(f);
    for (const f of [...this.sparse.keys()]) if (f > this.n) this.sparse.delete(f);
  }

  /** 復元すると壊れると分かったキーフレームを捨てる。
   *  記録の正本は入力列なので、キーフレームは何枚失っても再現性は落ちない。 */
  poison(frame: number): void {
    this.dense.delete(frame);
    this.sparse.delete(frame);
    this.poisoned.add(frame);
  }

  /** 捨てた地点。同じ場所を何度も掴まないために覚えておく */
  private poisoned = new Set<number>();

  addEvent(type: TimelineEvent["type"], frame: number, label?: string): void {
    this.events.push({ frame, type, label });
    this.events.sort((a, b) => a.frame - b.frame);
  }

  eventsAt(frame: number): TimelineEvent[] {
    return this.events.filter((e) => e.frame === frame);
  }

  /** 保存に残すキーフレーム。疎 + 末尾(後日の続きのため)。 */
  keyframesForFile(): Keyframe[] {
    const out: Keyframe[] = [];
    for (const [frame, state] of [...this.sparse.entries()].sort((a, b) => a[0] - b[0])) {
      out.push({ frame, state });
    }
    const tail = this.dense.get(this.n);
    if (tail && !this.sparse.has(this.n)) out.push({ frame: this.n, state: tail });
    return out;
  }

  meta(): RecordingMeta {
    return {
      version: FORMAT_VERSION,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      title: this.title,
      rom: this.rom,
      players: this.players,
      origin: this.origin,
      frameCount: this.n,
      rewinds: this.rewinds,
      discardedFrames: this.discardedFrames,
    };
  }

  /** ファイルから読んだ記録を、続きから書ける形に復元する。 */
  static restore(
    meta: RecordingMeta,
    input: Uint8Array,
    events: TimelineEvent[],
    keyframes: Keyframe[],
    originState: Uint8Array | null,
  ): Recorder {
    const r = new Recorder(meta.rom, meta.title, meta.origin);
    (r as { createdAt: string }).createdAt = meta.createdAt;
    r.players = meta.players;
    r.rewinds = meta.rewinds;
    r.discardedFrames = meta.discardedFrames;
    r.originState = originState;
    r.events = events.slice();
    const need = meta.frameCount * 2;
    r.buf = new Uint8Array(Math.max(need, 256));
    r.buf.set(input.subarray(0, need));
    r.n = meta.frameCount;
    for (const k of keyframes) {
      r.sparse.set(k.frame, k.state);
      // 末尾だけは密にも入れておく。読み込み直後に「続きから」を押せるように。
      if (k.frame === meta.frameCount) r.dense.set(k.frame, k.state);
    }
    return r;
  }
}
