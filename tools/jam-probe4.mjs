const hits = [];
const w = process.stderr.write.bind(process.stderr);
process.stderr.write = (c, ...r) => { const s = String(c); if (s.includes('JAM')) { hits.push(s); return true; } return w(c, ...r); };
const { NES } = await import('@nesjs/core');
const { readFileSync } = await import('node:fs');
const rom = new Uint8Array(readFileSync('/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES'));
const mk = async () => { const n = new NES({ audioSampleRate: 48000 }); n.setRenderer({ renderFrame(){} }); n.setAudioInterface({ outputSample(){}, flushFrame(){} }); await n.loadROM(rom); return n; };
const main = await mk();
const probe = await mk();
const inp = f => (f===60||f===61)?8:(f>90?0x80:0);
const bad = [];
for (let f = 0; f < 200; f++) {
  main.setInput(1, inp(f)); main.runFrame();
  const S = main.createBinarySaveState();
  const before = hits.length;
  probe.loadBinarySaveState(S);
  probe.setInput(1, inp(f)); probe.runFrame();
  if (hits.length > before) bad.push(f);
}
// 比較: 毎回まっさらなインスタンスを作った場合
const bad2 = [];
const main2 = await mk();
for (let f = 0; f < 60; f++) {
  main2.setInput(1, inp(f)); main2.runFrame();
  const S = main2.createBinarySaveState();
  const fresh = await mk();
  const before = hits.length;
  fresh.loadBinarySaveState(S);
  fresh.setInput(1, inp(f)); fresh.runFrame();
  if (hits.length > before) bad2.push(f);
}
process.stderr.write = w;
console.log('使い回しインスタンスで JAM したフレーム:', JSON.stringify(bad));
console.log('毎回新規インスタンスで JAM したフレーム (0..59):', JSON.stringify(bad2));
