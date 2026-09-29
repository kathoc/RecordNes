import { Session } from "../src/core/session.ts";
import { identifyRom } from "../src/core/romid.ts";
import { readFileSync } from "node:fs";
const bytes = new Uint8Array(readFileSync("/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES"));
const info = await identifyRom(bytes, "smb");
for (const ra of [0, 1, 2]) {
  let jam = 0;
  const orig = console.error;
  console.error = (...a: unknown[]) => { if (String(a[0]).includes("JAM")) jam++; else orig(...a); };
  const s = new Session({ runAhead: ra });
  await s.loadRom(bytes, info, "smb");
  for (let f = 0; f < 1000; f++) s.step([f === 60 || f === 61 ? 8 : f > 90 ? 0x80 : 0, 0]);
  console.error = orig;
  console.log(`runAhead=${ra}: JAM ${jam} 回, frame=${s.frame}`);
}
