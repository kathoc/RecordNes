import { NES } from '@nesjs/core';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const rom = new Uint8Array(readFileSync(process.argv[2]));
const TOTAL = Number(process.argv[3] ?? 600);
const MID = Math.floor(TOTAL / 2);

function makeNes() {
  const nes = new NES({ audioSampleRate: 48000 });
  let last = null;
  nes.setRenderer({ renderFrame: rgba => { last = rgba; } });
  let audio = 0;
  nes.setAudioInterface({ outputSample: s => { audio = (audio * 31 + s) | 0; }, flushFrame() {} });
  return { nes, frame: () => { nes.runFrame(); return last; }, audioHash: () => audio };
}

// Deterministic pseudo input: a fixed script, same every run.
function inputAt(f) {
  // start at 60, then run right + jump pattern
  if (f === 60 || f === 61) return 0b00001000; // START
  let b = 0;
  if (f > 90) b |= 0b10000000; // RIGHT
  if (f > 90 && (f % 37) < 12) b |= 0b00000001; // A
  if (f > 90 && (f % 53) < 20) b |= 0b00000010; // B
  return b;
}

const hash = buf => createHash('sha1').update(Buffer.from(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength ?? buf.length)).digest('hex').slice(0, 16);

async function run(withStateAt) {
  const { nes, frame, audioHash } = makeNes();
  await nes.loadROM(rom);
  let state = null, stateHashAfter = null, t0 = 0, saveMs = 0, loadMs = 0, size = 0;
  let fb = null;
  for (let f = 0; f < TOTAL; f++) {
    nes.setInput(1, inputAt(f));
    fb = frame();
    if (withStateAt === f) {
      t0 = performance.now();
      state = nes.createBinarySaveState();
      saveMs = performance.now() - t0;
      size = state.length;
    }
  }
  return { fbHash: hash(fb), audio: audioHash(), state, saveMs, size, nes, frame, audioHash };
}

console.log(`ROM: ${process.argv[2].split('/').pop()}  frames=${TOTAL}`);

const a = await run(-1);
const b = await run(-1);
console.log(`1) determinism (2 fresh runs): fb ${a.fbHash} vs ${b.fbHash} -> ${a.fbHash === b.fbHash ? 'PASS' : 'FAIL'}`);
console.log(`   audio accum: ${a.audio} vs ${b.audio} -> ${a.audio === b.audio ? 'PASS' : 'FAIL'}`);

// savestate round trip
const c = await run(MID);
console.log(`2) binary savestate: ${c.size} bytes, create ${c.saveMs.toFixed(2)} ms`);

const { nes: n2, frame: f2 } = makeNes();
await n2.loadROM(rom);
const tl = performance.now();
const ok = n2.loadBinarySaveState(c.state);
const loadMs = performance.now() - tl;
console.log(`   load returned ${ok}, ${loadMs.toFixed(2)} ms`);
let fb2 = null;
for (let f = MID + 1; f < TOTAL; f++) { n2.setInput(1, inputAt(f)); fb2 = f2(); }
console.log(`3) resume-from-state == continuous: ${hash(fb2)} vs ${c.fbHash} -> ${hash(fb2) === c.fbHash ? 'PASS' : 'FAIL'}`);
