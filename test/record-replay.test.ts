import { test } from "node:test";
import assert from "node:assert/strict";
import { SMB, SMB3, haveRom, hashPixels, newSession, scriptedInput } from "./helpers.ts";
import { serialize, parseToRecorder } from "../src/record/format.ts";
import { Session } from "../src/core/session.ts";
import { identifyRom } from "../src/core/romid.ts";
import { loadRomBytes } from "./helpers.ts";

const N = 400;

for (const [name, rom] of [["SMB (NROM)", SMB], ["SMB3 (MMC3)", SMB3]] as const) {
  test(`${name}: 記録 → 保存 → 読み込み → 再生 がフレーム単位で一致する`, async (t) => {
    if (!haveRom(rom)) return t.skip("ROM が無い");
    const live = await newSession(rom, 0);
    const script = scriptedInput(1);
    for (let f = 0; f < N; f++) live.step(script(f));
    const liveHash = hashPixels(live.emu.pixels);
    assert.equal(live.totalFrames, N, "記録されたフレーム数");

    const file = await serialize(live.rec!);
    const { rec } = await parseToRecorder(file);
    assert.equal(rec.frameCount, N);
    assert.deepEqual([...rec.inputBytes()], [...live.rec!.inputBytes()], "入力列が往復で一致");

    // 再生は別インスタンスで、電源投入から入力だけを流し込む。
    const bytes = loadRomBytes(rom);
    const info = await identifyRom(bytes, rom.split("/").pop()!);
    const play = new Session({ runAhead: 0 });
    await play.loadRom(bytes, info, info.name);
    await play.adoptRecording(rec, 0);
    play.mode = "playback";
    while (play.frame < N) play.step([0, 0]);
    assert.equal(hashPixels(play.emu.pixels), liveHash, "再生後の画面が記録時と一致");
  });
}

test("巻き戻して続けた記録に、巻き戻しの痕跡が残らない", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const live = await newSession(SMB, 0);
  const first = scriptedInput(2);
  for (let f = 0; f < 300; f++) live.step(first(f));

  // 150 まで巻き戻し、別のプレイで続ける。
  assert.ok(live.rewind(150), "巻き戻せる");
  assert.equal(live.frame, 150);
  assert.equal(live.totalFrames, 300, "巻き戻しただけでは記録は縮まない");

  const second = scriptedInput(9);
  for (let f = 150; f < 300; f++) live.step(second(f));
  assert.equal(live.totalFrames, 300, "書き込んだ時点で先が切られ、同じ長さで続く");
  assert.equal(live.rec!.rewinds, 1);
  const liveHash = hashPixels(live.emu.pixels);

  // 保存した記録は、最初から一本で通したプレイとして再現できる。
  const file = await serialize(live.rec!);
  const { rec } = await parseToRecorder(file);
  const bytes = loadRomBytes(SMB);
  const info = await identifyRom(bytes, "smb");
  const play = new Session({ runAhead: 0 });
  await play.loadRom(bytes, info, info.name);
  await play.adoptRecording(rec, 0);
  play.mode = "playback";
  while (play.frame < 300) play.step([0, 0]);
  assert.equal(hashPixels(play.emu.pixels), liveHash);

  // 150 フレーム目以降の入力は、2 本目のプレイのものだけになっている。
  for (let f = 150; f < 300; f++) {
    assert.deepEqual(rec.inputAt(f), second(f), `frame ${f} の入力`);
  }
});

test("巻き戻してから元の続きを見るだけなら、記録は変わらない", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const live = await newSession(SMB, 0);
  const script = scriptedInput(3);
  for (let f = 0; f < 300; f++) live.step(script(f));
  const before = [...live.rec!.inputBytes()];
  const tailHash = hashPixels(live.emu.pixels);

  live.rewind(100);
  live.mode = "playback";
  while (live.frame < 300) live.step([0, 0]);
  assert.deepEqual([...live.rec!.inputBytes()], before, "再生で戻っただけでは記録は無傷");
  assert.equal(hashPixels(live.emu.pixels), tailHash, "同じ画面に戻る");
  assert.equal(live.rec!.rewinds, 0);
});

test("ラン・アヘッドを変えても、記録される入力と到達状態は同じ", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const script = scriptedInput(4);
  const a = await newSession(SMB, 0);
  for (let f = 0; f < 240; f++) a.step(script(f));
  const b = await newSession(SMB, 2);
  for (let f = 0; f < 240; f++) b.step(script(f));
  assert.deepEqual([...b.rec!.inputBytes()], [...a.rec!.inputBytes()], "記録される入力は同じ");
  assert.equal(b.frame, a.frame, "進んだフレーム数は同じ");
  // 内部状態が一致することを、保存した状態のバイト列で確かめる。
  assert.deepEqual([...b.emu.saveState()], [...a.emu.saveState()], "内部状態も同じ");
});

test("リセットを含む記録が再現できる（記録を消さない設定）", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const live = await newSession(SMB, 0);
  live.resetClearsRecording = false;
  const script = scriptedInput(5);
  for (let f = 0; f < 200; f++) live.step(script(f));
  await live.reset();
  assert.equal(live.rec!.events.filter((e) => e.type === "reset").length, 1);
  for (let f = 200; f < 400; f++) live.step(script(f));
  const liveHash = hashPixels(live.emu.pixels);
  assert.equal(live.totalFrames, 400);

  const file = await serialize(live.rec!);
  const { rec } = await parseToRecorder(file);
  assert.equal(rec.events.filter((e) => e.type === "reset").length, 1, "リセットが保存されている");

  const bytes = loadRomBytes(SMB);
  const info = await identifyRom(bytes, "smb");
  const play = new Session({ runAhead: 0 });
  await play.loadRom(bytes, info, info.name);
  await play.adoptRecording(rec, 0);
  play.mode = "playback";
  while (play.frame < 400) play.step([0, 0]);
  assert.equal(hashPixels(play.emu.pixels), liveHash, "リセットごと再現できる");
});

test("途中で保存して、別セッションで続きから記録できる", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const day1 = await newSession(SMB, 0);
  const script = scriptedInput(6);
  for (let f = 0; f < 320; f++) day1.step(script(f));
  const file = await serialize(day1.rec!);

  const { rec } = await parseToRecorder(file);
  const bytes = loadRomBytes(SMB);
  const info = await identifyRom(bytes, "smb");
  const day2 = new Session({ runAhead: 0 });
  await day2.loadRom(bytes, info, info.name);
  await day2.adoptRecording(rec, "tail");
  assert.equal(day2.frame, 320, "末尾から再開する");
  // 続きを 80 フレーム記録する。
  for (let f = 320; f < 400; f++) day2.step(script(f));
  assert.equal(day2.totalFrames, 400);
  const day2Hash = hashPixels(day2.emu.pixels);

  // 続けて記録したものが、最初から一本で通したのと同じになる。
  const straight = await newSession(SMB, 0);
  for (let f = 0; f < 400; f++) straight.step(script(f));
  assert.equal(day2Hash, hashPixels(straight.emu.pixels));
});

test("巻き戻して同じ長さまで撮り直すと、未保存として扱われる", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const s = await newSession(SMB, 0);
  const a = scriptedInput(51);
  for (let f = 0; f < 300; f++) s.step(a(f));
  const savedRevision = s.rec!.revision;
  const savedFrames = s.totalFrames;

  s.rewind(100);
  const b = scriptedInput(52);
  for (let f = 200; f < 300; f++) s.step(b(f));

  assert.equal(s.totalFrames, savedFrames, "長さは元に戻っている");
  assert.notEqual(s.rec!.revision, savedRevision, "長さが同じでも書き換わったと分かる");
});

test("覚えた地点は、そこより前を切り詰めたときだけ無効になる", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const s = await newSession(SMB, 0);
  const script = scriptedInput(53);
  for (let f = 0; f < 300; f++) s.step(script(f));

  const at = 100;
  const since = s.rec!.truncMark();
  assert.equal(s.rec!.isStable(at, since), true);

  // 覚えた地点より後ろを撮り直しても、その地点は生きている。
  s.rewind(50);
  for (let f = 250; f < 300; f++) s.step(script(f));
  assert.equal(s.rec!.isStable(at, since), true, "後ろの撮り直しでは無効にならない");

  // 覚えた地点より前を撮り直したら、中身が変わるので無効。
  s.rewind(250);
  for (let f = 50; f < 120; f++) s.step(script(f));
  assert.equal(s.rec!.isStable(at, since), false, "前を撮り直したら無効になる");
});

test("ROM を積み直している最中は、記録に書き込まない", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const s = await newSession(SMB, 0);
  const script = scriptedInput(61);
  for (let f = 0; f < 200; f++) s.step(script(f));
  const before = s.totalFrames;

  // await をまたぐ作業の最中に step が来ても、記録を壊さないこと。
  // (実際の UI では rAF ループがこれをやる)
  const work = s.setSampleRate(44100);
  for (let i = 0; i < 50; i++) s.step([0, 0]);
  await work;
  assert.equal(s.totalFrames, before, "待っている間の step で記録が消えない");
  assert.equal(s.frame, before, "同じ位置に戻ってくる");
});

test("目印を打つと、未保存として扱われる", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const s = await newSession(SMB, 0);
  for (let f = 0; f < 120; f++) s.step([0, 0]);
  const saved = s.rec!.revision;
  s.mark("ここ");
  assert.notEqual(s.rec!.revision, saved, "目印も書き換えとして数える");
});

test("リセットで記録を作り直すと、未保存として扱われる", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const s = await newSession(SMB, 0);
  for (let f = 0; f < 150; f++) s.step([0, 0]);
  const before = s.rec!;
  await s.reset();                     // 既定では記録ごと作り直す
  assert.notEqual(s.rec, before, "Recorder が入れ替わる");
  assert.equal(s.rec!.revision, 0, "新しい記録の書き換え回数は 0 から");
  // ここで「保存したときの revision」を持ち越すと、同じ数値になって
  // 保存済みに見えてしまう。UI 側でも戻していることを app.ts で担保している。
});
