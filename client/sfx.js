// 音效：全部用 Web Audio 即時合成（不用音檔），走 audio.js 的「音效」匯流排（設定面板調音量）。
// sfx.play(名稱, { x, vol, ...參數 })：x = 發出聲音的世界座標（做左右聲道），vol = 這一聲的音量倍率
// 要調哪個聲音就改底下 SOUNDS 裡那一條；GAP = 同一種聲音最短間隔（同一幀好幾顆砲彈爆炸只響一次）
import { CONFIG } from '../shared/config.js';
import { audio } from './audio.js';

const GAP = { step: 0.06, explode: 0.05, hurt: 0.06, splash: 0.15, plop: 0.05, buzz: 0.2, yourTurn: 0.5 };
const R = (a, b) => a + Math.random() * (b - a);

let noiseBuf = null;
function noiseBuffer(ctx) {
  if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

// 音量包絡：attack 秒內拉到 vol，接著 dur 秒指數衰減到無聲
function env(ctx, t, attack, vol, dur) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
  return g;
}

// 一個音：振盪器頻率 f0 → f1
function tone(ctx, out, t, { type = 'sine', f0, f1 = f0, dur, vol, attack = 0.004 }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + attack + dur);
  o.connect(env(ctx, t, attack, vol, dur)).connect(out);
  o.start(t);
  o.stop(t + attack + dur + 0.02);
}

// 一段雜訊：經過濾波器（頻率 f0 → f1）
function noise(ctx, out, t, { filter = 'lowpass', f0, f1 = f0, q = 1, dur, vol, attack = 0.002 }) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + attack + dur);
  s.connect(f).connect(env(ctx, t, attack, vol, dur)).connect(out);
  s.start(t, R(0, 1.5));
  s.stop(t + attack + dur + 0.02);
}

const SOUNDS = {
  // 腳步：悶悶的一小聲，每步音高稍微不同
  step(ctx, out, t) {
    const k = R(0.85, 1.15);
    noise(ctx, out, t, { filter: 'lowpass', f0: 1400 * k, f1: 500 * k, dur: 0.06, vol: 0.22 });
    tone(ctx, out, t, { type: 'triangle', f0: 150 * k, f1: 80 * k, dur: 0.05, vol: 0.12 });
  },
  // 跳躍：往上滑的「咻」
  jump(ctx, out, t) {
    tone(ctx, out, t, { type: 'triangle', f0: 240, f1: 640, dur: 0.16, vol: 0.28, attack: 0.01 });
    tone(ctx, out, t, { type: 'sine', f0: 480, f1: 1280, dur: 0.12, vol: 0.06, attack: 0.01 });
    noise(ctx, out, t, { filter: 'highpass', f0: 2000, dur: 0.05, vol: 0.05 });
  },
  // 大砲：低沉的「碰」＋砲口的「啵」
  cannon(ctx, out, t) {
    tone(ctx, out, t, { type: 'sine', f0: 160, f1: 42, dur: 0.4, vol: 0.85 });
    noise(ctx, out, t, { filter: 'lowpass', f0: 3000, f1: 250, dur: 0.38, vol: 0.5 });
    noise(ctx, out, t, { filter: 'highpass', f0: 2500, dur: 0.03, vol: 0.3 });
  },
  // 狙擊槍：清脆的「啪」，後面跟兩聲越來越悶、越來越小的山谷回聲
  sniper(ctx, out, t) {
    const crack = (tt, v, hz) => {
      noise(ctx, out, tt, { filter: 'bandpass', f0: hz, f1: hz * 0.5, q: 0.7, dur: 0.09, vol: v });
      tone(ctx, out, tt, { type: 'square', f0: 1600, f1: 220, dur: 0.07, vol: v * 0.15 });
    };
    crack(t, 0.8, 4000);
    tone(ctx, out, t, { type: 'sine', f0: 110, f1: 50, dur: 0.12, vol: 0.4 });
    crack(t + 0.17, 0.18, 2200);
    crack(t + 0.36, 0.07, 1400);
  },
  // 爆炸：big = 大砲那種會挖大坑的；小的（狙擊槍打到地上）只有短短一聲
  explode(ctx, out, t, { big = true }) {
    if (big) {
      noise(ctx, out, t, { filter: 'lowpass', f0: 2600, f1: 120, dur: 0.9, vol: 0.9 });
      tone(ctx, out, t, { type: 'sine', f0: 95, f1: 30, dur: 0.7, vol: 0.9 });
      noise(ctx, out, t + 0.05, { filter: 'bandpass', f0: 600, f1: 200, q: 0.8, dur: 0.5, vol: 0.3 });   // 土石落下
    } else {
      noise(ctx, out, t, { filter: 'lowpass', f0: 2000, f1: 300, dur: 0.22, vol: 0.45 });
      tone(ctx, out, t, { type: 'sine', f0: 150, f1: 60, dur: 0.16, vol: 0.35 });
    }
  },
  // 砲彈掉進水裡：「噗通」
  plop(ctx, out, t) {
    tone(ctx, out, t, { type: 'sine', f0: 900, f1: 180, dur: 0.12, vol: 0.25 });
    noise(ctx, out, t, { filter: 'bandpass', f0: 1500, f1: 700, q: 1.2, dur: 0.25, vol: 0.3 });
  },
  // 角色掉進水裡：大水花＋幾個冒泡聲
  splash(ctx, out, t) {
    noise(ctx, out, t, { filter: 'bandpass', f0: 500, f1: 2400, q: 0.9, dur: 0.12, vol: 0.7, attack: 0.01 });
    noise(ctx, out, t + 0.1, { filter: 'bandpass', f0: 2400, f1: 600, q: 0.9, dur: 0.5, vol: 0.45 });
    tone(ctx, out, t, { type: 'sine', f0: 300, f1: 90, dur: 0.2, vol: 0.4 });
    let bt = t + 0.15;
    for (let i = 0; i < 4; i++) {
      const f = R(500, 1100);
      tone(ctx, out, bt, { type: 'sine', f0: f, f1: f * 1.8, dur: 0.05, vol: 0.08 });
      bt += R(0.06, 0.11);
    }
  },
  // 被打中：短促的「嗚」
  hurt(ctx, out, t) {
    tone(ctx, out, t, { type: 'square', f0: 380, f1: 160, dur: 0.12, vol: 0.08 });
    noise(ctx, out, t, { filter: 'lowpass', f0: 1200, dur: 0.06, vol: 0.25 });
  },
  // 進入慢動作：往下沉的「嗡——」＋一陣風聲
  slowIn(ctx, out, t) {
    tone(ctx, out, t, { type: 'sine', f0: 560, f1: 120, dur: 0.5, vol: 0.22, attack: 0.02 });
    tone(ctx, out, t, { type: 'triangle', f0: 280, f1: 60, dur: 0.55, vol: 0.1, attack: 0.02 });
    noise(ctx, out, t, { filter: 'bandpass', f0: 2200, f1: 350, q: 0.8, dur: 0.45, vol: 0.12, attack: 0.04 });
  },
  // 慢動作解除（落地、體力用完；開火那次有砲聲就不播）：短短往上滑一下
  slowOut(ctx, out, t) {
    tone(ctx, out, t, { type: 'sine', f0: 140, f1: 460, dur: 0.18, vol: 0.14, attack: 0.01 });
    noise(ctx, out, t, { filter: 'bandpass', f0: 500, f1: 2000, q: 0.8, dur: 0.15, vol: 0.06 });
  },
  // 蜜蜂（小心擊發）：兩個稍微走音的鋸齒波疊在一起的「嗡嗡」，加一點翅膀的沙沙聲
  buzz(ctx, out, t) {
    for (const f of [208, 215]) tone(ctx, out, t, { type: 'sawtooth', f0: f, f1: f * 1.12, dur: 0.38, vol: 0.035, attack: 0.04 });
    noise(ctx, out, t, { filter: 'bandpass', f0: 900, f1: 1400, q: 4, dur: 0.32, vol: 0.05, attack: 0.04 });
  },
  // 輪到你了（單人、多人都響，見 GameView.cueTurn）：木琴似的三個音往上「叮、叮、叮——」，最後一個音拉長；不分左右聲道
  yourTurn(ctx, out, t) {
    const notes = [[784, 0], [1047, 0.09], [1568, 0.18]];   // G5 → C6 → G6
    notes.forEach(([f, dt], i) => {
      const last = i === notes.length - 1;
      tone(ctx, out, t + dt, { type: 'sine', f0: f, dur: last ? 0.55 : 0.16, vol: 0.32 });
      tone(ctx, out, t + dt, { type: 'sine', f0: f * 4, dur: 0.05, vol: 0.05 });   // 敲下去那一下的亮音
    });
  },
};

export const sfx = {
  last: new Map(),   // 名稱 → 上次播放的時間（ctx.currentTime）

  play(name, opts = {}) {
    const ctx = audio.ensure();
    // 還沒解鎖（沒點過畫面）、音效關掉：直接不播，不要堆到之後一起響（分頁在背景照樣播，見 audio.js）
    if (!ctx || ctx.state !== 'running' || audio.volume('sfx') <= 0 || !SOUNDS[name]) return;
    const now = ctx.currentTime;
    if (now - (this.last.has(name) ? this.last.get(name) : -1) < (GAP[name] || 0.03)) return;
    this.last.set(name, now);
    const out = ctx.createGain();
    out.gain.value = opts.vol === undefined ? 1 : opts.vol;
    if (opts.x !== undefined && ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, opts.x / CONFIG.WORLD_W * 2 - 1)) * 0.7;
      out.connect(pan).connect(audio.bus('sfx'));
    } else {
      out.connect(audio.bus('sfx'));
    }
    SOUNDS[name](ctx, out, now + 0.005, opts);
  },
};

// 叢林巨蟒登場的哈氣：一聲長長的「嘶——」（約 2 秒），叢林巨蟒的 BGM 開頭用（music.js 的 intro: 'hiss'）。
// 主體是 3~10 kHz 的嘶聲，共鳴點往上滑、越噴越用力；底下墊一點 1 kHz 左右的氣音讓牠聽起來很大隻；
// 音量帶一點不規則的抖動（氣流不穩），左右聲道各一份雜訊（比較寬），再加一點殘響。dest = 要接到哪條匯流排
export function snakeHiss(ctx, dest, t, vol = 1) {
  const dur = 2;
  const out = ctx.createGain();
  out.gain.value = vol;
  out.connect(dest);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.55, t + 0.08);   // 一下子噴出來
  env.gain.linearRampToValueAtTime(1, t + 0.7);       // 越來越用力
  env.gain.setValueAtTime(1, t + 1.15);
  env.gain.exponentialRampToValueAtTime(0.001, t + dur);
  env.connect(out);
  const verb = ctx.createConvolver();
  verb.buffer = hissImpulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.25;
  env.connect(verb).connect(wet).connect(out);

  const am = ctx.createGain();                          // 氣流不穩的抖動
  am.gain.value = 0.85;
  const wob = loopNoise(ctx, t, t + dur);
  const wobLp = ctx.createBiquadFilter();
  wobLp.type = 'lowpass';
  wobLp.frequency.value = 8;
  const wobDepth = ctx.createGain();
  wobDepth.gain.value = 6;
  wob.connect(wobLp).connect(wobDepth).connect(am.gain);
  am.connect(env);

  for (const side of [-0.3, 0.3]) {                     // 主體的嘶聲（左右各一份）
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2800;
    const peak = ctx.createBiquadFilter();
    peak.type = 'peaking';
    peak.Q.value = 1;
    peak.gain.value = 7;
    peak.frequency.setValueAtTime(4500, t);
    peak.frequency.linearRampToValueAtTime(6500, t + 1.2);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 10000;
    const pan = ctx.createStereoPanner();
    pan.pan.value = side;
    loopNoise(ctx, t, t + dur).connect(hp).connect(peak).connect(lp).connect(gainNode(ctx, 0.5)).connect(pan).connect(am);
  }
  const body = ctx.createBiquadFilter();               // 低一點的氣音
  body.type = 'bandpass';
  body.frequency.value = 1100;
  body.Q.value = 0.8;
  loopNoise(ctx, t, t + dur).connect(body).connect(gainNode(ctx, 0.15)).connect(am);
}

function loopNoise(ctx, t, end) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx);
  s.loop = true;
  s.start(t, R(0, 2));
  s.stop(end);
  return s;
}

function gainNode(ctx, v) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

let hissIr = null;
function hissImpulse(ctx) {
  if (!hissIr || hissIr.sampleRate !== ctx.sampleRate) {
    const sr = ctx.sampleRate, n = Math.round(sr * 1.4);
    hissIr = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = hissIr.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.3));
    }
  }
  return hissIr;
}
