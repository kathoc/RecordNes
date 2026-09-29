/** コアが「CPU が止まった」と言ってきたのを捕まえる。
 *
 *  ## なぜ要るか（2026-09-29 の調査）
 *
 *  Super Mario Bros. を電源投入から 30 フレーム進めた地点でセーブステートを取り、
 *  それを復元して 1 フレーム走らせると、コアが
 *  `CPU JAM/KIL instruction executed - CPU halted` を console.warn へ出して CPU が止まる。
 *  以後そのインスタンスは何も進まない。
 *
 *  再現条件と範囲は `tools/jam-scan.mjs` で測った。SMB の 2000 フレーム中 1 件
 *  (フレーム 30 の地点のみ)、SMB3 では 0 件。インスタンスを使い回しても、毎回
 *  新規に作っても同じフレームで起きるので、**保存された状態そのものが復元不能**。
 *  フレーム 29 は SMB がまだリセット処理の中にいる時間帯で、コアの
 *  `loadBinarySaveState` がその時点の CPU 状態を取りこぼしていると見られる。
 *
 *  ## 対処
 *
 *  コアを直すのが筋だが、配布物は最小化済みで手が入れられない。そこで
 *  **キーフレームを信用せず、使ったあとに壊れていないかを確かめる**作りにした。
 *  止まったと分かったら、そのキーフレームを捨て、入力列を電源投入から流し直す。
 *  記録の正本は入力列であってキーフレームではないので、これで必ず復旧できる。
 *
 *  この仕掛けは今回の 1 件専用ではない。コア側に同種の取りこぼしが他にあっても、
 *  同じ経路で黙って直る。
 *
 *  console.error を包むのは、コアがこれ以外に停止を知らせる手段を持たないため
 *  (`getDebugInfo()` にも停止フラグは無い)。**コアを読み込むより先に**包む必要が
 *  あるので、このモジュールはエントリの一番上で import すること。 */

let jammed = false;

const PATTERN = /JAM|KIL|CPU halted/i;

/** コアがどの口から言ってくるかは版によって違う (実測では console.warn だった)。
 *  4 つとも包んでおく方が、版が上がったときに黙って効かなくなるより安全。 */
const CHANNELS = ["error", "warn", "log", "info"] as const;

function install(): void {
  const target = globalThis.console as unknown as Record<string, unknown> & { __recordnesJamWatch?: boolean };
  if (!target || target.__recordnesJamWatch) return;
  for (const ch of CHANNELS) {
    const original = (target[ch] as ((...a: unknown[]) => void) | undefined)?.bind(globalThis.console);
    if (!original) continue;
    target[ch] = (...args: unknown[]): void => {
      if (args.some((a) => PATTERN.test(String(a)))) jammed = true;
      original(...args);
    };
  }
  target.__recordnesJamWatch = true;
}

install();

/** 前回この関数を呼んでから CPU が止まったか。呼ぶと旗は下りる。 */
export function consumeJam(): boolean {
  const v = jammed;
  jammed = false;
  return v;
}

export function clearJam(): void {
  jammed = false;
}
