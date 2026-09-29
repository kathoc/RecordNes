// 遅延と 1 フレームあたりの計算時間を実測する。tools/perftest.sh から使う。
// 体感で語らないための数字。
const app = window.recordnesApp;
const s = app.session;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !s.rec; i++) await sleep(100);

// rAF の間隔
const gaps = [];
await new Promise((done) => {
  let last = 0, n = 0;
  const tick = (t) => {
    if (last) gaps.push(t - last);
    last = t;
    if (++n < 300) requestAnimationFrame(tick); else done();
  };
  requestAnimationFrame(tick);
});
gaps.sort((a, b) => a - b);
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

// ラン・アヘッド段数ごとの 1 フレームの計算時間
const runahead = [];
for (const n of [0, 1, 2, 3]) {
  await s.setRunAhead(n);
  await sleep(400);
  const emu = [], ra = [], st = [];
  for (let i = 0; i < 90; i++) {
    await sleep(20);
    emu.push(s.lastStats.emuMs); ra.push(s.lastStats.runAheadMs); st.push(s.lastStats.stateMs);
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  runahead.push({
    段数: n,
    本体ms: +avg(emu).toFixed(2),
    先読みms: +avg(ra).toFixed(2),
    状態保存ms: +avg(st).toFixed(2),
    合計ms: +(avg(emu) + avg(ra) + avg(st)).toFixed(2),
  });
}
await s.setRunAhead(1);

// キーを押してからエミュレートに使われるまでの実時間
const lat = [];
for (let i = 0; i < 40; i++) {
  await sleep(23 + (i % 7));
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true }));
  const t = performance.now();
  const seen = await new Promise((r) => {
    const f = s.frame;
    const wait = () => (s.frame > f ? r(performance.now()) : requestAnimationFrame(wait));
    wait();
  });
  lat.push(seen - t);
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "ArrowRight", bubbles: true }));
}
lat.sort((a, b) => a - b);

return {
  rAF間隔ms: { 中央: +pct(gaps, 0.5).toFixed(2), p95: +pct(gaps, 0.95).toFixed(2), 本数: gaps.length },
  ラン・アヘッド: runahead,
  入力からエミュレートまでms: { 中央: +pct(lat, 0.5).toFixed(2), p95: +pct(lat, 0.95).toFixed(2) },
  音声遅延ms: +app.audio.latencyMs().toFixed(2),
  フレーム予算ms: 16.64,
};
