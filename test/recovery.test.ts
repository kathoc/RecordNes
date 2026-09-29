import { test } from "node:test";
import assert from "node:assert/strict";
import { SMB, haveRom, hashPixels, newSession, scriptedInput } from "./helpers.ts";

/** コアのセーブステートは SMB のフレーム 29 の地点を復元しきれず、復元後に CPU が
 *  止まる (調査の経緯は src/core/jam-watch.ts)。記録の正本は入力列なので、
 *  そこから作り直せば必ず戻れる。その経路が働くことを確かめる。 */
test("復元できないキーフレームを掴んでも、記録から作り直して復旧する", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const s = await newSession(SMB, 0);
  const script = scriptedInput(11);
  for (let f = 0; f < 200; f++) s.step(script(f));

  // フレーム 31 を狙うと、1 つ手前 (壊れているフレーム 30 のキーフレーム) から
  // 入り直すことになり、そこで CPU が止まる。
  assert.equal(s.seek(31), false, "壊れたキーフレームを掴んだことを検知する");
  assert.equal(s.pendingRecovery, 31, "立て直しを要求する");

  await s.recover();
  assert.equal(s.frame, 31, "同じ位置へ戻ってくる");
  assert.equal(s.pendingRecovery, null);

  // 以後は普通に進む。同じ入力を流せば、一本で通したのと同じ画面になる。
  for (let f = 31; f < 200; f++) s.step(script(f));
  assert.equal(s.pendingRecovery, null, "二度と止まらない");
  const straight = await newSession(SMB, 0);
  for (let f = 0; f < 200; f++) straight.step(script(f));
  assert.equal(hashPixels(s.emu.pixels), hashPixels(straight.emu.pixels), "復旧後の画面が一致");
});

test("捨てたキーフレームは二度と使われない", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const s = await newSession(SMB, 0);
  const script = scriptedInput(12);
  for (let f = 0; f < 200; f++) s.step(script(f));
  s.seek(31);
  await s.recover();
  // もう一度同じ場所を狙っても、壊れたキーフレームは残っていない。
  assert.ok(s.seek(31), "今度は復元に成功する");
  assert.equal(s.pendingRecovery, null, "もう止まらない");
});

test("書き出しの途中で状態が壊れていたら、黙って固まった動画を出さない", async (t) => {
  if (!haveRom(SMB)) return t.skip("ROM が無い");
  const { Exporter } = await import("../src/export/exporter.ts");
  const { NodeBridge } = await import("./node-bridge.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const { Recorder } = await import("../src/record/recorder.ts");

  const s = await newSession(SMB, 0);
  const script = scriptedInput(41);
  for (let f = 0; f < 200; f++) s.step(script(f));

  // 復元できないフレーム 30 のキーフレームだけを持つ記録を組み立てる。
  // 保存したファイルには 300 フレームおきのキーフレームしか入らないので、
  // 本来なら滅多に掴まないが、掴んだときに黙って進んではいけない。
  const bad = s.rec!.nearestState(30)!;
  assert.equal(bad.frame, 30);
  const rec = Recorder.restore(
    s.rec!.meta(), s.rec!.inputBytes(), s.rec!.events, [bad], null,
  );
  const out = join(mkdtempSync(join(tmpdir(), "recordnes-jam-")), "jam.mp4");
  await assert.rejects(
    () => new Exporter().run(
      new NodeBridge(out), s.romData()!, rec,
      { from: 31, to: 120 },
      { scale: 1, fps: 60, crf: 30, audio: false, overlayInput: false },
      () => {}, "jam.mp4",
    ),
    /復元できませんでした/,
    "復元できない地点から始めたら、成功として返さない",
  );
});
