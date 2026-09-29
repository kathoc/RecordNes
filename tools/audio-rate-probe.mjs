import { NES } from '@nesjs/core';
import { readFileSync } from 'node:fs';
const rom = new Uint8Array(readFileSync('/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES'));
for (const sr of [48000, 44100]) {
  const nes = new NES({ audioSampleRate: sr });
  nes.setRenderer({ renderFrame(){} });
  let n=0; nes.setAudioInterface({ outputSample(){ n++; }, flushFrame(){} });
  await nes.loadROM(rom);
  const F=1200; for (let i=0;i<F;i++){ nes.setInput(1,0x80); nes.runFrame(); }
  console.log(`sampleRate=${sr}  samples/frame=${(n/F).toFixed(4)}  導出fps=${(sr/(n/F)).toFixed(4)}  nes.fps=${nes.fps}`);
}
