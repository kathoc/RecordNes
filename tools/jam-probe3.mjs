const hits = [];
const w = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...r) => { const s = String(chunk); if (s.includes('JAM')) { hits.push(s); return true; } return w(chunk, ...r); };
const { Session } = await import('../src/core/session.ts');
const { identifyRom } = await import('../src/core/romid.ts');
const { readFileSync } = await import('node:fs');
const bytes = new Uint8Array(readFileSync('/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES'));
const info = await identifyRom(bytes, 'smb');
const s = new Session({ runAhead: 1 });
const marks = [];
await s.loadRom(bytes, info, 'smb');
if (hits.length) marks.push({ at: 'loadRom', n: hits.length });
for (let f = 0; f < 300; f++) {
  const before = hits.length;
  s.step([f === 60 || f === 61 ? 8 : f > 90 ? 0x80 : 0, 0]);
  if (hits.length > before) marks.push({ frame: f, n: hits.length - before });
}
process.stderr.write = w;
console.log('発生箇所:', JSON.stringify(marks.slice(0, 8)), '総数', hits.length);
