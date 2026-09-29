/** `.rnes` ファイルの読み書き。
 *
 *  ROM は同梱しない(著作権)。sha1 と crc32 だけを持ち、再生時に照合する。
 *
 *  レイアウト:
 *    0  "RNES"            4B
 *    4  フォーマット版     u16 LE
 *    6  ヘッダ長           u32 LE
 *   10  ヘッダ JSON (UTF-8)
 *   ..  バイナリ区画 (ヘッダの sections が offset/length で指す)
 *
 *  入力列は非圧縮のまま置く。1 時間でも 432KB しかなく、圧縮しても得が小さい一方、
 *  部分読みや破損時の救出がしやすい。重いキーフレームだけ個別に deflate する。 */

import type { Keyframe, RecordingMeta, TimelineEvent } from "./types.ts";
import { MAGIC } from "./types.ts";
import { Recorder } from "./recorder.ts";

interface Section {
  offset: number;
  length: number;
}

interface FileHeader extends RecordingMeta {
  keyframeIndex: { frame: number; offset: number; length: number }[];
  sections: {
    INPUT: Section;
    EVENTS: Section;
    KEYS: Section;
    ORIGIN?: Section;
    SRAM?: Section;
  };
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const src = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(src).arrayBuffer());
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const src = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(src).arrayBuffer());
}

export interface ParsedRecording {
  meta: RecordingMeta;
  input: Uint8Array;
  events: TimelineEvent[];
  keyframes: Keyframe[];
  originState: Uint8Array | null;
  sram: Uint8Array | null;
}

export async function serialize(rec: Recorder, sram: Uint8Array | null = null): Promise<Uint8Array> {
  const input = rec.inputBytes();
  const events = new TextEncoder().encode(JSON.stringify(rec.events));

  const keys = rec.keyframesForFile();
  const keyBlobs: Uint8Array[] = [];
  const keyframeIndex: FileHeader["keyframeIndex"] = [];
  let keyOff = 0;
  for (const k of keys) {
    const z = await deflate(k.state);
    keyframeIndex.push({ frame: k.frame, offset: keyOff, length: z.length });
    keyBlobs.push(z);
    keyOff += z.length;
  }
  const keysBlob = concat(keyBlobs);
  const originBlob = rec.originState ? await deflate(rec.originState) : null;

  let off = 0;
  const sections: FileHeader["sections"] = {
    INPUT: { offset: (off += 0), length: input.length },
    EVENTS: { offset: (off += input.length), length: events.length },
    KEYS: { offset: (off += events.length), length: keysBlob.length },
  };
  off += keysBlob.length;
  if (originBlob) {
    sections.ORIGIN = { offset: off, length: originBlob.length };
    off += originBlob.length;
  }
  if (sram) {
    sections.SRAM = { offset: off, length: sram.length };
    off += sram.length;
  }

  const header: FileHeader = { ...rec.meta(), keyframeIndex, sections };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));

  const body = concat([input, events, keysBlob, ...(originBlob ? [originBlob] : []), ...(sram ? [sram] : [])]);
  const out = new Uint8Array(10 + headerBytes.length + body.length);
  out.set([0x52, 0x4e, 0x45, 0x53], 0); // "RNES"
  const dv = new DataView(out.buffer);
  dv.setUint16(4, header.version, true);
  dv.setUint32(6, headerBytes.length, true);
  out.set(headerBytes, 10);
  out.set(body, 10 + headerBytes.length);
  return out;
}

export async function parse(bytes: Uint8Array): Promise<ParsedRecording> {
  if (bytes.length < 10 || String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error("RecordNes の記録ファイルではありません");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(4, true);
  if (version > 1) throw new Error(`この版では読めない記録です (フォーマット版 ${version})`);
  const headerLen = dv.getUint32(6, true);
  if (10 + headerLen > bytes.length) throw new Error("記録ファイルのヘッダが壊れています");

  let header: FileHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(10, 10 + headerLen)));
  } catch {
    throw new Error("記録ファイルのヘッダを読めません");
  }
  const base = 10 + headerLen;
  const slice = (s: Section | undefined): Uint8Array | null => {
    if (!s) return null;
    const a = base + s.offset;
    const b = a + s.length;
    if (b > bytes.length) throw new Error("記録ファイルが途中で切れています");
    return bytes.subarray(a, b);
  };

  const input = slice(header.sections.INPUT) ?? new Uint8Array(0);
  const eventsRaw = slice(header.sections.EVENTS);
  const events: TimelineEvent[] = eventsRaw && eventsRaw.length
    ? JSON.parse(new TextDecoder().decode(eventsRaw))
    : [];
  const keysBlob = slice(header.sections.KEYS) ?? new Uint8Array(0);

  const keyframes: Keyframe[] = [];
  for (const k of header.keyframeIndex ?? []) {
    const z = keysBlob.subarray(k.offset, k.offset + k.length);
    keyframes.push({ frame: k.frame, state: await inflate(z) });
  }
  const originZ = slice(header.sections.ORIGIN);
  const originState = originZ ? await inflate(originZ) : null;
  const sram = slice(header.sections.SRAM);

  const { keyframeIndex: _k, sections: _s, ...meta } = header;
  return { meta: meta as RecordingMeta, input: input.slice(), events, keyframes, originState, sram: sram ? sram.slice() : null };
}

export async function parseToRecorder(bytes: Uint8Array): Promise<{ rec: Recorder; parsed: ParsedRecording }> {
  const p = await parse(bytes);
  return { rec: Recorder.restore(p.meta, p.input, p.events, p.keyframes, p.originState), parsed: p };
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 記録に合う既定のファイル名。 */
export function suggestFileName(meta: RecordingMeta): string {
  const safe = meta.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "recording";
  const stamp = meta.updatedAt.replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  return `${safe}-${stamp}.rnes`;
}
