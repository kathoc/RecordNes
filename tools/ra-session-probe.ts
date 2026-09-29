import { newSession, scriptedInput } from "../test/helpers.ts";
import { SMB } from "../test/helpers.ts";
const script = scriptedInput(4);
const a = await newSession(SMB, 0);
const b = await newSession(SMB, 2);
for (let f = 0; f < 240; f++) {
  a.step(script(f));
  b.step(script(f));
  const sa = a.emu.saveState(), sb = b.emu.saveState();
  if (sa.length !== sb.length || !sa.every((v, i) => v === sb[i])) {
    const pos: number[] = [];
    for (let i = 0; i < Math.min(sa.length, sb.length) && pos.length < 8; i++) if (sa[i] !== sb[i]) pos.push(i);
    console.log(`最初の相違: frame ${f + 1}  長さ ${sa.length} vs ${sb.length}  相違位置 ${pos.join(",")}`);
    console.log(`入力 ${JSON.stringify(script(f))}  a.frame=${a.frame} b.frame=${b.frame}`);
    break;
  }
}
console.log("done");
