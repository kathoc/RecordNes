import { NES } from '@nesjs/core';
import { readFileSync } from 'node:fs';
const rom = new Uint8Array(readFileSync(process.argv[2]));
const nes = new NES({ audioSampleRate: 48000 });
let fb=null; nes.setRenderer({ renderFrame: r => { fb=r; } });
nes.setAudioInterface({ outputSample(){}, flushFrame(){} });
await nes.loadROM(rom);
for (let i=0;i<300;i++) nes.runFrame();
// steady state savestate cost
let t=performance.now(); let n=200; let sz=0;
for (let i=0;i<n;i++){ const s=nes.createBinarySaveState(); sz=s.length; nes.runFrame(); }
const per=(performance.now()-t)/n;
t=performance.now(); for(let i=0;i<300;i++) nes.runFrame();
const framePer=(performance.now()-t)/300;
const st=nes.createBinarySaveState();
t=performance.now(); for(let i=0;i<200;i++) nes.loadBinarySaveState(st);
const loadPer=(performance.now()-t)/200;
console.log(`frame ${framePer.toFixed(3)} ms | savestate ${(per-framePer).toFixed(3)} ms (${sz} B) | load ${loadPer.toFixed(3)} ms`);
