// 実アプリの中で走らせる自動検証。tools/selftest.sh から使う。
// window.recordnesApp（本物のインスタンス）を、本物の rAF ループごと動かして確かめる。
const app = window.recordnesApp;
const s = app.session;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => window.recordnes.shot(n);
const log = [];
const check = (name, cond, detail) => { log.push({ name, ok: !!cond, detail }); };

const key = (code, type) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
const hold = async (code, ms) => { key(code, "keydown"); await sleep(ms); key(code, "keyup"); };

// 1. ROM が読み込まれ、記録が始まっていること
for (let i = 0; i < 100 && !(s.rec && s.frame > 0); i++) await sleep(100);
check("ROM が読み込まれ記録が始まる", !!s.rec && s.frame > 0, { frame: s.frame });

// 2. 実時間どおりに進むこと（1 秒 ≒ 60 フレーム）
const f0 = s.frame;
await sleep(2000);
const advanced = s.frame - f0;
check("実速度で進む", advanced > 100 && advanced < 135, { advanced });

// 3. 音が出口まで流れているか（実際の可聴確認はこの環境ではできない）
check("音声の経路が動いている", app.audio.started && app.audio.sentSamples > 5000, {
  started: app.audio.started, sentSamples: app.audio.sentSamples, sampleRate: app.audio.sampleRate,
});

// 4. キーボードで START を押してゲームを始める
await hold("Enter", 120);
await sleep(2500);
await shot("selftest-1-game");

// 4. 右へ走る
key("ArrowRight", "keydown");
await sleep(1500);
check("無音ではない波形が出ている", app.audio.lastPeak > 0.001, { peak: app.audio.lastPeak });
check("エミュレーターと出口のサンプルレートが一致する",
  s.emu.sampleRate === app.audio.sampleRate,
  { emu: s.emu.sampleRate, out: app.audio.sampleRate });
check("入力が届いている", s.lastInput[0] !== 0, { lastInput: s.lastInput[0] });
key("ArrowRight", "keyup");
await shot("selftest-2-running");

// 5. 巻き戻し
const beforeRewind = s.frame;
const totalBefore = s.totalFrames;
await hold("Backspace", 1000);
await sleep(50);
const rewound = beforeRewind - s.frame;
// 巻き戻しの速さは既定 2x。1 秒押せば約 120 フレーム戻る。
check("巻き戻しの量が実時間どおり", rewound > 70 && rewound < 200, { beforeRewind, after: s.frame, rewound });
check("巻き戻しただけでは記録は縮まない", s.totalFrames === totalBefore, { totalBefore, now: s.totalFrames });
check("巻き戻すと再生モードへ移る", s.mode === "playback", { mode: s.mode });
await shot("selftest-3-rewound");

// 6. 巻き戻した先から遊び直すと、記録がそこでつながる
const spliceAt = s.frame;
key("ArrowLeft", "keydown");
await sleep(800);
key("ArrowLeft", "keyup");
await sleep(100);
check("引き継いで記録モードに戻る", s.mode === "record", { mode: s.mode });
check("巻き戻し後に記録がつながる", s.totalFrames < totalBefore && s.totalFrames > spliceAt, {
  spliceAt, totalBefore, now: s.totalFrames, rewinds: s.rec.rewinds,
});
check("巻き戻し回数が数えられている", s.rec.rewinds >= 1, { rewinds: s.rec.rewinds });

// 7. スロー
app.setSpeed(2); // 1/4
const g0 = s.frame;
await sleep(1200);
const slow = s.frame - g0;
app.setSpeed(4);
check("スローで進みが遅くなる", slow > 5 && slow < 40, { slow });

// 8. 一時停止とコマ送り
app.setPaused(true);
const p0 = s.frame;
await sleep(600);
check("一時停止で止まる", s.frame === p0, { p0, now: s.frame });
await hold("KeyF", 50);
await sleep(300);
check("コマ送りで 1 フレームだけ進む", s.frame === p0 + 1, { p0, now: s.frame });
app.setPaused(false);

// 9. 連射モードの巡回
const modes = [];
for (let i = 0; i < 3; i++) { await hold("KeyT", 50); await sleep(120); modes.push(app.input.turbo.state.mode); }
check("連射モードが 3 状態を巡る", modes.join(",") === "hold,toggle,off", { modes });

// 10. 4-way / 8-way
await hold("KeyW", 50); await sleep(120);
check("4-way に切り替わる", app.input.ways === 4, { ways: app.input.ways });
await hold("KeyW", 50); await sleep(120);

// 11. 記録の保存と読み込み（ファイルダイアログを通さず中身で確かめる）
app.setPaused(true);   // 書き出している間に記録が伸びないよう止める
await sleep(100);
const mod = window.recordnesFormat;
const savedFrames = s.totalFrames;
const bytes = await mod.serialize(s.rec, s.emu.sram());
const back = await mod.parseToRecorder(bytes);
check("保存した記録を読み戻せる", back.rec.frameCount === savedFrames, {
  saved: savedFrames, loaded: back.rec.frameCount, size: bytes.length,
});
check("入力列が往復で一致する",
  JSON.stringify([...back.rec.inputBytes()]) === JSON.stringify([...s.rec.inputBytes()]), {});
app.setPaused(false);

// 12. 保存した記録を読み込んで、最初から再生し、同じ画面に着く
const hash = (px) => { let h = 2166136261; for (let i = 0; i < px.length; i += 7) { h ^= px[i]; h = Math.imul(h, 16777619); } return h >>> 0; };
const endHash = hash(s.emu.pixels);
await app.openRecordingBytes(bytes);        // 末尾から再開する形で読み込む
check("記録を読み込むと末尾に着く", s.frame === savedFrames, { frame: s.frame, savedFrames });
check("末尾の画面が記録時と一致する", hash(s.emu.pixels) === endHash, {});

s.playFromStart();
check("最初から再生できる", s.frame === 0 && s.mode === "playback", { frame: s.frame, mode: s.mode });
app.setPaused(false);
// 再生を最後まで見届ける（早送りで待ち時間を詰める）
app.setSpeed(7);
for (let i = 0; i < 300 && s.frame < savedFrames; i++) await sleep(50);
app.setSpeed(4);
check("再生が末尾まで進む", s.frame >= savedFrames, { frame: s.frame, savedFrames });
check("再生後の画面が記録時と一致する", hash(s.emu.pixels) === endHash, {});
app.setPaused(true);

// 13. 目印
app.addMarker();
check("目印が打てる", s.markers().length >= 1, { markers: s.markers().length });

await shot("selftest-4-final");
return { ok: log.every((x) => x.ok), log, frames: s.totalFrames };
