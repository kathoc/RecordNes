import { NES } from '@nesjs/core';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const rom = new Uint8Array(readFileSync('/home/sonohoka/Playground/roms/nes/Super Mario Bros. (World).NES'));
const mk = async () => { const n=new NES({audioSampleRate:48000}); let fb=null;
  n.setRenderer({renderFrame:r=>{fb=r;}}); let ah=0;
  n.setAudioInterface({outputSample:s=>{ah=(ah*31+Math.round(s*1e6))|0;},flushFrame(){}});
  await n.loadROM(rom); return {n,fb:()=>fb,ah:()=>ah}; };
const inp = f => (f===60||f===61)?8:(f>90?(0x80|((f%37)<12?1:0)):0);
const h = b => createHash('sha1').update(Buffer.from(b)).digest('hex').slice(0,12);

// 基準インスタンス: 300 フレーム進めて S を取る
const A = await mk();
for (let f=0;f<300;f++){A.n.setInput(1,inp(f));A.n.runFrame();}
const S = A.n.createBinarySaveState();
// A を汚す: 先読み 2 フレーム → 戻す
for (let i=0;i<2;i++){A.n.setInput(1,inp(300));A.n.runFrame();}
A.n.loadBinarySaveState(S);
// B: まっさらなインスタンスへ S を読む
const B = await mk();
B.n.loadBinarySaveState(S);
// 同じ入力で 600 フレーム回して、映像と音を比べる
for (let f=300;f<900;f++){ A.n.setInput(1,inp(f)); A.n.runFrame(); B.n.setInput(1,inp(f)); B.n.runFrame(); }
console.log('映像:', h(A.fb()), h(B.fb()), h(A.fb())===h(B.fb())?'一致':'不一致');
console.log('音声累積:', A.ah(), B.ah(), A.ah()===B.ah()?'一致':'不一致');
const S1=A.n.createBinarySaveState(), S2=B.n.createBinarySaveState();
let d=0; for(let i=0;i<S1.length;i++) if(S1[i]!==S2[i]) d++;
console.log('600フレーム後の状態の相違バイト数:', d, '/', S1.length);
