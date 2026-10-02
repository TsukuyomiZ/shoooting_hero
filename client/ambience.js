// 環境音：即時合成的樹葉沙沙聲，古樹之庭疊在 BGM 上（見 music.js 的 TRACKS.tree.leaves）。
// 做法：先算好一段「葉子素材」——幾千片葉子輕輕拍打的聲音疊在一起（每一下都很短、大多很輕、偶爾一片大一點），
// 再一陣一陣地放：風吹起來時樹枝慢慢搖（音量緩慢起伏）、風越大聲音越亮，從一邊掃到另一邊；
// 高頻收掉一點、加一點殘響，聽起來像頭頂上遠一點的樹冠。陣風之間是安靜的。
// AudioContext 和 OfflineAudioContext 都能用（離線算的話用 renderAll 一次排好）
const R = (a, b) => a + Math.random() * (b - a);
const clamp1 = (v) => Math.max(-1, Math.min(1, v));

const GUST_GAP = [3, 8];          // 兩陣風之間隔幾秒
const LEAF_VOL = 0.5;             // 一陣風最大時的音量（素材本身 RMS 約 0.1）
const REVERB_MIX = 0.4;           // 殘響比例
const TEXTURE_SEC = 6;            // 葉子素材長度（循環播放、每陣風從不同位置開始）
const GRAINS_PER_SEC = 160;       // 素材裡每秒幾片葉子拍打（每個聲道）
const GRAIN_HZ = [800, 4000];     // 每片葉子的音高範圍
const GRAIN_LEN = [0.006, 0.03];  // 每片葉子的聲音長度（秒）

const cache = new WeakMap();      // ctx → { texture, impulse }

// 葉子素材：雙聲道各自獨立（聽起來比較寬），grain 超出結尾的部分繞回開頭，循環起來沒有接縫
function makeTexture(ctx) {
  const sr = ctx.sampleRate, n = Math.round(sr * TEXTURE_SEC);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const count = Math.round(GRAINS_PER_SEC * TEXTURE_SEC);
    for (let g = 0; g < count; g++) {
      const start = Math.floor(Math.random() * n);
      const len = Math.floor(sr * R(GRAIN_LEN[0], GRAIN_LEN[1]));
      const att = Math.max(1, Math.floor(sr * R(0.0015, 0.004)));
      const amp = Math.random() ** 2.5;                                   // 大多很輕，偶爾一片大一點
      const f = GRAIN_HZ[0] * (GRAIN_HZ[1] / GRAIN_HZ[0]) ** Math.random();
      // 帶通濾波（RBJ biquad）：每片葉子有自己的音色
      const w = 2 * Math.PI * f / sr, q = R(0.9, 1.6), al = Math.sin(w) / (2 * q), cw = Math.cos(w);
      const a0 = 1 + al, b0 = al / a0, b2 = -al / a0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      const tau = len / 3;
      for (let i = 0; i < len; i++) {
        const e = i < att ? i / att : Math.exp(-(i - att) / tau);
        const x = (Math.random() * 2 - 1) * e;
        const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        d[(start + i) % n] += y * amp;
      }
    }
    let s = 0;
    for (let i = 0; i < n; i++) s += d[i] * d[i];
    const k = 0.1 / Math.sqrt(s / n);
    for (let i = 0; i < n; i++) d[i] *= k;
  }
  return buf;
}

// 殘響：指數衰減的雜訊當脈衝響應
function makeImpulse(ctx, sec = 1.6) {
  const sr = ctx.sampleRate, n = Math.round(sr * sec);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.35));
  }
  return buf;
}

function assets(ctx) {
  let a = cache.get(ctx);
  if (!a) { a = { texture: makeTexture(ctx), impulse: makeImpulse(ctx) }; cache.set(ctx, a); }
  return a;
}

export class LeafAmbience {
  // dest = 接到哪裡（曲子自己的音量節點）；level = 整體音量倍率
  constructor(ctx, dest, level = 1) {
    this.ctx = ctx;
    this.assets = assets(ctx);
    this.out = ctx.createGain();
    this.out.gain.value = level;
    this.out.connect(dest);
    this.verb = ctx.createConvolver();
    this.verb.buffer = this.assets.impulse;
    this.verb.connect(this.gain(REVERB_MIX)).connect(this.out);
    this.sources = new Set();      // 還在跑的音源（stop 時一起停）
    this.nextGust = 0;
    this.timer = null;
  }

  // 即時播放：每 0.5 秒把之後 2 秒內的風排好（分頁在背景、AudioContext 暫停時時間不走，就不會一直往後排）
  start() {
    this.nextGust = this.ctx.currentTime + R(0.5, 2);
    const tick = () => this.schedule(this.ctx.currentTime + 2);
    tick();
    this.timer = setInterval(tick, 500);
  }

  // 離線：一次排好 [0, until) 的風
  renderAll(until) {
    this.nextGust = R(0.5, 2);
    this.schedule(until);
  }

  stop(at = this.ctx.currentTime) {
    clearInterval(this.timer);
    this.timer = null;
    for (const s of this.sources) { try { s.stop(at); } catch {} }
  }

  schedule(until) {
    while (this.nextGust < until) {
      this.gust(this.nextGust);
      this.nextGust += R(GUST_GAP[0], GUST_GAP[1]);
    }
  }

  // 一陣風
  gust(t) {
    const ctx = this.ctx;
    const k = R(0.4, 1);                                     // 這陣風多大
    const a = R(1, 2.2), h = R(0.5, 2), r = R(1.8, 3.5);     // 吹起來、持續、停下來
    const end = t + a + h + r * 1.6;

    const src = ctx.createBufferSource();
    src.buffer = this.assets.texture;
    src.loop = true;
    src.playbackRate.value = R(0.9, 1.1);
    this.track(src, t, end, R(0, TEXTURE_SEC));

    // 風越大越亮
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2200, t);
    lp.frequency.setTargetAtTime(3000 + 2600 * k, t, a / 3);
    lp.frequency.setTargetAtTime(2200, t + a + h, r / 3);

    // 樹枝搖擺：兩個慢速的起伏疊在一起
    const sway = ctx.createGain();
    sway.gain.value = 0.65;
    for (const [hz, depth] of [[R(1.5, 3.5), 0.22], [R(0.4, 0.9), 0.13]]) {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      o.connect(this.gain(depth)).connect(sway.gain);
      this.track(o, t, end);
    }

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.setTargetAtTime(k * LEAF_VOL, t, a / 3);
    env.gain.setTargetAtTime(0, t + a + h, r / 3);

    const pan = ctx.createStereoPanner();                    // 風從一邊掃到另一邊
    const p0 = R(-0.6, 0.6);
    pan.pan.setValueAtTime(p0, t);
    pan.pan.linearRampToValueAtTime(clamp1(p0 + R(-0.7, 0.7)), end);

    src.connect(lp).connect(sway).connect(env).connect(pan);
    pan.connect(this.out);
    pan.connect(this.verb);
  }

  track(node, t, end, offset) {
    if (offset === undefined) node.start(t); else node.start(t, offset);
    node.stop(end);
    this.sources.add(node);
    node.onended = () => this.sources.delete(node);
  }

  gain(v) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }
}
