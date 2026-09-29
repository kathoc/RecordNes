/** iNES / NES 2.0 ヘッダの読み取りと、ROM の同一性判定。
 *
 *  記録ファイルは ROM を同梱しない(著作権)。代わりに sha1 と crc32 を持ち、
 *  再生時に「同じ ROM か」を照合する。crc32 だけにしないのは、既存のエミュレーター
 *  文化に合わせつつ、衝突の心配を無くすため。 */

export interface RomInfo {
  /** ファイル名(拡張子つき)。表示用で、照合には使わない。 */
  name: string;
  size: number;
  sha1: string;
  crc32: string;
  mapper: number;
  prgBanks: number;
  chrBanks: number;
  /** 0 = 水平, 1 = 垂直 */
  mirroring: number;
  hasBattery: boolean;
  hasTrainer: boolean;
  /** NES 2.0 ヘッダなら true */
  nes20: boolean;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function crc32Hex(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).padStart(8, "0").toUpperCase();
}

/** SHA-1。Node 22 とブラウザのどちらでも WebCrypto が使える。 */
export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const d = await crypto.subtle.digest("SHA-1", buf as ArrayBuffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isINes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 16 &&
    bytes[0] === 0x4e && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1a
  );
}

/** ヘッダが宣言している最小サイズ。切り詰められた ROM を読み込む前に弾く。 */
export function declaredSize(bytes: Uint8Array): number {
  const trainer = bytes[6] & 0x04 ? 512 : 0;
  return 16 + trainer + bytes[4] * 16384 + bytes[5] * 8192;
}

export async function identifyRom(bytes: Uint8Array, name: string): Promise<RomInfo> {
  if (!isINes(bytes)) throw new Error("iNES 形式の ROM ではありません (先頭の NES\\x1A が見つかりません)");
  if (bytes.length < declaredSize(bytes)) {
    throw new Error(`ROM が途中で切れています (ヘッダは ${declaredSize(bytes)} バイトと宣言、実際は ${bytes.length} バイト)`);
  }
  const nes20 = (bytes[7] & 0x0c) === 0x08;
  const mapper = nes20
    ? ((bytes[8] & 0x0f) << 8) | (bytes[7] & 0xf0) | (bytes[6] >> 4)
    : (bytes[7] & 0xf0) | (bytes[6] >> 4);
  return {
    name,
    size: bytes.length,
    sha1: await sha1Hex(bytes),
    crc32: crc32Hex(bytes),
    mapper,
    prgBanks: bytes[4],
    chrBanks: bytes[5],
    mirroring: bytes[6] & 1,
    hasBattery: (bytes[6] & 2) !== 0,
    hasTrainer: (bytes[6] & 4) !== 0,
    nes20,
  };
}

/** ヘッダのタイトルは NES には無いので、ファイル名から拡張子と括弧書きを落として使う。 */
export function displayTitle(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/\s*[(\[][^)\]]*[)\]]/g, "").trim() || name;
}
