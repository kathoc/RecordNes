import { NES } from '@nesjs/core';
import { readFileSync } from 'node:fs';
const rom = new Uint8Array(readFileSync('/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES'));
const nes = new NES({ audioSampleRate: 48000 });
nes.setRenderer({ renderFrame(){} });
nes.setAudioInterface({ outputSample(){}, flushFrame(){} });
await nes.loadROM(rom);
for (let i=0;i<200;i++){ nes.setInput(1, 0x80); nes.runFrame(); }
const S = nes.createBinarySaveState();
// A: 同じインスタンスで先読みして戻す
for (let i=0;i<2;i++){ nes.setInput(1,0x80); nes.runFrame(); }
const ok = nes.loadBinarySaveState(S);
const S2 = nes.createBinarySaveState();
console.log('load ok:', ok, 'len', S.length, '->', S2.length);
let diff=0; const n=Math.min(S.length,S2.length);
for (let i=0;i<n;i++) if (S[i]!==S2[i]) diff++;
console.log('同一インスタンスで復元: 長さ差', S2.length-S.length, '/ 先頭', n, 'バイト中の相違', diff);
// 先頭の相違位置
const pos=[]; for (let i=0;i<n && pos.length<12;i++) if (S[i]!==S2[i]) pos.push(i);
console.log('相違位置:', pos);
