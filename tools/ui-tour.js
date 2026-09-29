// 画面をひととおり開いて撮る。見た目は文章では確かめられない。
const app = window.recordnesApp;
const s = app.session;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (n) => window.recordnes.shot(n);
for (let i = 0; i < 100 && !s.rec; i++) await sleep(100);
await sleep(2500);   // タイトルが出るまで待つ。起動中の START は効かない
window.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter" }));
await sleep(150);
window.dispatchEvent(new KeyboardEvent("keyup", { code: "Enter" }));
await sleep(3000);
window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight" }));
await sleep(2000);
window.dispatchEvent(new KeyboardEvent("keyup", { code: "ArrowRight" }));

// 連射を入れ、4-way にし、速度を落とした状態の画面表示
app.input.turbo.setMode("toggle");
app.input.setWays(4);
app.setSpeed(2);
app.addMarker();
await sleep(600);
await shot("tour-1-playing");
app.setSpeed(4);

document.getElementById("btn-help").click();
await sleep(400);
await shot("tour-2-help");
document.getElementById("btn-settings").click();
await sleep(400);
await shot("tour-3-settings");
document.getElementById("btn-export").click();
await sleep(400);
await shot("tour-4-export");
return { ok: true };
