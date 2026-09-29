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

  // 壊れている地点へ戻る。
  assert.ok(s.seek(30), "キーフレームからの復元自体は成功する");
  assert.equal(s.frame, 30);

  // 次の 1 フレームで CPU が止まり、立て直しが要求される。
  s.step(script(30));
  assert.equal(s.pendingRecovery, 30, "止まったことを検知して立て直しを要求する");

  await s.recover();
  assert.equal(s.frame, 30, "同じ位置へ戻ってくる");
  assert.equal(s.pendingRecovery, null);

  // 以後は普通に進む。同じ入力を流せば、一本で通したのと同じ画面になる。
  for (let f = 30; f < 200; f++) s.step(script(f));
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
  s.seek(30);
  s.step(script(30));
  await s.recover();
  // もう一度同じ場所を狙っても、壊れたキーフレームは残っていない。
  s.seek(30);
  s.step(script(30));
  assert.equal(s.pendingRecovery, null, "もう止まらない");
});
