const seen = [];
for (const ch of ['log','info','warn','error']) {
  const o = console[ch].bind(console);
  console[ch] = (...a) => { if (String(a[0]).includes('JAM')) seen.push(ch); else o(...a); };
}
const { NES } = await import('@nesjs/core');
const { readFileSync } = await import('node:fs');
const rom = new Uint8Array(readFileSync('/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES'));
const mk = async () => { const n=new NES({audioSampleRate:48000}); n.setRenderer({renderFrame(){}}); n.setAudioInterface({outputSample(){},flushFrame(){}}); await n.loadROM(rom); return n; };
const m = await mk(), p = await mk();
for (let f=0; f<40; f++){ m.setInput(1,0); m.runFrame(); const S=m.createBinarySaveState(); p.loadBinarySaveState(S); p.setInput(1,0); p.runFrame(); }
process.stdout.write('通知が来た口: ' + (seen.length ? seen.join(',') : '(捕まらず)') + '\n');
