const hits = [];
const orig = console.error;
console.error = (...a) => { hits.push(String(a[0])); };
const { Session } = await import('../src/core/session.ts');
const { identifyRom } = await import('../src/core/romid.ts');
const { readFileSync } = await import('node:fs');
const bytes = new Uint8Array(readFileSync('/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES'));
const info = await identifyRom(bytes, 'smb');
const s = new Session({ runAhead: 1 });
await s.loadRom(bytes, info, 'smb');
const marks = [];
for (let f = 0; f < 300; f++) {
  const before = hits.length;
  s.step([f === 60 || f === 61 ? 8 : f > 90 ? 0x80 : 0, 0]);
  if (hits.length > before) marks.push({ frame: f, msg: hits[hits.length-1] });
}
console.error = orig;
console.log('発生:', marks.slice(0, 5), '総数', hits.length);
