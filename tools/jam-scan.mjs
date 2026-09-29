const hits = [];
const w = process.stderr.write.bind(process.stderr);
process.stderr.write = (c, ...r) => { const s = String(c); if (s.includes('JAM')) { hits.push(s); return true; } return w(c, ...r); };
const { NES } = await import('@nesjs/core');
const { readFileSync } = await import('node:fs');
const roms = {
  SMB: '/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES',
  SMB3: '/home/sonohoka/Playground/roms/nes/Super Mario Bros. 3 (Japan) (Rev A).NES',
};
const inp = f => (f===60||f===61||f===200||f===201)?8:(f>240?(0x80|((f%37)<12?1:0)):0);
const out = [];
for (const [name, path] of Object.entries(roms)) {
  const rom = new Uint8Array(readFileSync(path));
  const mk = async () => { const n = new NES({ audioSampleRate: 48000 }); n.setRenderer({ renderFrame(){} }); n.setAudioInterface({ outputSample(){}, flushFrame(){} }); await n.loadROM(rom); return n; };
  const main = await mk(); const probe = await mk();
  const bad = [];
  const N = 2000;
  for (let f = 0; f < N; f++) {
    main.setInput(1, inp(f)); main.runFrame();
    const S = main.createBinarySaveState();
    const before = hits.length;
    probe.loadBinarySaveState(S);
    probe.setInput(1, inp(f)); probe.runFrame();
    if (hits.length > before) bad.push(f);
  }
  out.push(`${name}: ${N} フレーム中 JAM ${bad.length} 件 ${JSON.stringify(bad.slice(0, 20))}`);
}
process.stderr.write = w;
for (const l of out) console.log(l);
