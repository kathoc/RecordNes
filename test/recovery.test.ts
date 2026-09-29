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
