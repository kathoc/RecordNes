// 未保存の記録を抱えたまま閉じようとしたとき、本当に引き止められるかを見る。
// ネイティブのダイアログは自動では押せないので、「出たところで止まる」ことを
// 確認する。止まらずに終われば、黙って閉じているということ。
const app = window.recordnesApp;
const s = app.session;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !(s.rec && s.frame > 60); i++) await sleep(100);
if (!app.hasUnsavedWork()) throw new Error("未保存の記録が用意できていません");
window.close();
await sleep(4000);
return { ok: true, note: "ここに来た時点で、閉じるのが止められている" };
