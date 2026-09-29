import { NES } from '@nesjs/core';
import { readFileSync } from 'node:fs';
const rom = new Uint8Array(readFileSync('/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES'));
async function mk(sinkOn) {
  const nes = new NES({ audioSampleRate: 48000 });
  nes.setRenderer({ renderFrame(){} });
  nes.setAudioInterface({ outputSample(){}, flushFrame(){} });
  await nes.loadROM(rom);
  return nes;
}
for (const warm of [0, 1, 5, 200]) {
  const nes = await mk();
  for (let i=0;i<warm;i++){ nes.setInput(1,0); nes.runFrame(); }
  nes.setInput(1,0); nes.runFrame();
  const S = nes.createBinarySaveState();
  for (let i=0;i<2;i++){ nes.setInput(1,0); nes.runFrame(); }
  nes.loadBinarySaveState(S);
  const S2 = nes.createBinarySaveState();
  const pos=[]; for (let i=0;i<Math.min(S.length,S2.length) && pos.length<6;i++) if (S[i]!==S2[i]) pos.push(i);
  console.log(`warm=${warm} len ${S.length}/${S2.length} 相違 ${pos.length?pos.join(','):'なし'}`);
}
