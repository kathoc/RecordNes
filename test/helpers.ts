import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { Session } from "../src/core/session.ts";
import { identifyRom } from "../src/core/romid.ts";

export const ROM_DIR = "/home/sonohoka/Playground/roms/nes";
export const SMB = `${ROM_DIR}/Super Mario Bros. (World).NES`;
export const SMB3 = `${ROM_DIR}/Super Mario Bros. 3 (Japan) (Rev A).NES`;

export const haveRom = (p: string): boolean => existsSync(p);

export function loadRomBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

export async function newSession(path: string, runAhead = 0): Promise<Session> {
  const bytes = loadRomBytes(path);
  const info = await identifyRom(bytes, path.split("/").pop()!);
  const s = new Session({ runAhead });
  await s.loadRom(bytes, info, info.name);
  return s;
}

export function hashPixels(p: Uint8Array): string {
  return createHash("sha1").update(Buffer.from(p)).digest("hex").slice(0, 16);
}

/** 決まった入力列。テストごとに種を変えて別のプレイにする。 */
export function scriptedInput(seed: number) {
  return (f: number): [number, number] => {
    if (f === 40 + (seed % 7) || f === 41 + (seed % 7)) return [0b00001000, 0];
    if (f < 70) return [0, 0];
    let b = 0b10000000; // RIGHT
    if ((f + seed) % (17 + (seed % 5)) < 6) b |= 0b00000001; // A
    if ((f * 3 + seed) % 23 < 9) b |= 0b00000010; // B
    return [b, 0];
  };
}
