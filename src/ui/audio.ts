/** 音声出力。
 *
 *  遅延を詰めるため、バッファは 3 フレーム分(約 50ms)しか持たない。そこまで薄くすると、
 *  rAF(約 60Hz) と AudioContext(48000Hz) のわずかなずれが数十秒で効いてきて、
 *  バッファが空になる(プチッと切れる)か溢れる(遅れが溜まる)。
 *
 *  なので**動的レート調整**を入れる。溜まり具合を見て、読み出し速度を ±0.5% だけ
 *  曲げる。音程のずれは 8 セント未満で、耳では分からない。切れるよりずっとよい。
 *
 *  プロセッサは Blob URL から読み込む。別ファイルにすると Vite / Electron /
 *  将来の Android で置き場所の話が毎回出るので、ここに文字列で持つ。 */

const PROCESSOR_SOURCE = `
class NesSink extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const cap = (options.processorOptions && options.processorOptions.capacity) || 16384;
    this.buf = new Float32Array(cap);
    this.cap = cap;
    this.write = 0;
    this.read = 0;      // 小数。動的レート調整で歩幅が変わる
    this.target = (options.processorOptions && options.processorOptions.target) || 2400;
    this.ratio = 1;
    this.starved = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d === "flush") { this.write = 0; this.read = 0; return; }
      const n = d.length;
      for (let i = 0; i < n; i++) {
        this.buf[this.write] = d[i];
        this.write = (this.write + 1) % this.cap;
      }
    };
  }
  available() {
    const w = this.write, r = Math.floor(this.read);
    return w >= r ? w - r : w + this.cap - r;
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const avail = this.available();

    // 溜まり具合から読み出し速度を決める。多ければ速く、少なければ遅く。
    const err = (avail - this.target) / this.target;
    const want = 1 + Math.max(-0.005, Math.min(0.005, err * 0.05));
    this.ratio += (want - this.ratio) * 0.05;   // 急に変えると音程が揺れる

    if (avail < 64) {
      this.starved++;
      L.fill(0); if (R !== L) R.fill(0);
      return true;
    }
    for (let i = 0; i < L.length; i++) {
      const idx = Math.floor(this.read) % this.cap;
      const next = (idx + 1) % this.cap;
      const frac = this.read - Math.floor(this.read);
      const s = this.buf[idx] * (1 - frac) + this.buf[next] * frac;
      L[i] = s; if (R !== L) R[i] = s;
      this.read += this.ratio;
      if (this.read >= this.cap) this.read -= this.cap;
      if (this.available() < 2) break;
    }
    return true;
  }
}
registerProcessor("nes-sink", NesSink);
`;

export class AudioOut {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  gain: GainNode | null = null;
  started = false;
  muted = false;
  volume = 0.7;

  /** 1 フレーム分の溜め。まとめて送ると postMessage の回数が減る */
  private pending: number[] = [];
  /** これまでに出口へ送ったサンプル数。音が本当に流れているかの確認に使う */
  sentSamples = 0;
  /** 直近に送った塊の振幅の最大値。無音のまま気づかない事故を防ぐ */
  lastPeak = 0;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  /** ユーザー操作の中で呼ぶこと (自動再生制限)。 */
  async start(): Promise<void> {
    if (this.started) return;
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const url = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const target = Math.round(ctx.sampleRate / 60) * 3; // 3 フレーム分
    const node = new AudioWorkletNode(ctx, "nes-sink", {
      outputChannelCount: [2],
      processorOptions: { capacity: 1 << 15, target },
    });
    const gain = ctx.createGain();
    gain.gain.value = this.muted ? 0 : this.volume;
    node.connect(gain).connect(ctx.destination);
    this.ctx = ctx;
    this.node = node;
    this.gain = gain;
    this.started = true;
    if (ctx.state === "suspended") await ctx.resume();
  }

  /** エミュレーターのサンプルを受ける。`Session.setSink` に渡す。 */
  push = (s: number): void => {
    this.pending.push(s);
  };

  /** 1 フレーム終わるごとに呼ぶ。溜めた分を送り出す。 */
  flush(): void {
    if (!this.node || this.pending.length === 0) {
      this.pending.length = 0;
      return;
    }
    const arr = new Float32Array(this.pending);
    this.pending.length = 0;
    let peak = 0;
    for (let i = 0; i < arr.length; i++) { const a = Math.abs(arr[i]); if (a > peak) peak = a; }
    this.lastPeak = peak;
    this.sentSamples += arr.length;
    this.node.port.postMessage(arr, [arr.buffer]);
  }

  /** 早送りや巻き戻し中に溜まった音を捨てる。 */
  drop(): void {
    this.pending.length = 0;
  }

  clear(): void {
    this.pending.length = 0;
    this.node?.port.postMessage("flush");
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.gain) this.gain.gain.value = m ? 0 : this.volume;
  }

  /** 出力までの遅延 (ms)。計測表示用。 */
  latencyMs(): number {
    if (!this.ctx) return 0;
    const base = (this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0);
    return base * 1000;
  }
}
