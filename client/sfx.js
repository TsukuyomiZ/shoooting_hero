// 音效：全部用 Web Audio 即時合成（不用音檔），走 audio.js 的「音效」匯流排（設定面板調音量）。
// sfx.play(名稱, { x, vol, ...參數 })：x = 發出聲音的世界座標（做左右聲道），vol = 這一聲的音量倍率
// 要調哪個聲音就改底下 SOUNDS 裡那一條；GAP = 同一種聲音最短間隔（同一幀好幾顆砲彈爆炸只響一次）
import { CONFIG } from '../shared/core/config.js';
import { audio } from './audio.js';

const GAP = { step: 0.06, explode: 0.05, hurt: 0.06, splash: 0.15, plop: 0.05, buzz: 0.2, yourTurn: 0.5, thunk: 0.05, fizzle: 0.1, chime: 0.06 };
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
  // 飛鏢：輕快的破風「咻」
  dart(ctx, out, t) {
    noise(ctx, out, t, { filter: 'highpass', f0: 3500, f1: 1800, dur: 0.08, vol: 0.28 });
    tone(ctx, out, t, { type: 'triangle', f0: 1400, f1: 700, dur: 0.07, vol: 0.08 });
  },
  // 西洋刺劍：往前一刺的「唰」（短促的破風聲）加一點金屬的「錚」
  stab(ctx, out, t) {
    noise(ctx, out, t, { filter: 'bandpass', f0: 2600, f1: 5200, q: 1.2, dur: 0.09, vol: 0.32, attack: 0.006 });
    tone(ctx, out, t + 0.02, { type: 'triangle', f0: 2400, f1: 2100, dur: 0.14, vol: 0.05 });
  },
  // 飛鏢插進地面：短促的「咚」
  thunk(ctx, out, t) {
    tone(ctx, out, t, { type: 'triangle', f0: 320, f1: 140, dur: 0.07, vol: 0.3 });
    noise(ctx, out, t, { filter: 'bandpass', f0: 1800, f1: 900, q: 1.5, dur: 0.05, vol: 0.18 });
  },
  // 高壓水炮：低沉的「轟」加上一長串水柱噴出去的嘶聲
  waterJet(ctx, out, t) {
    tone(ctx, out, t, { type: 'sine', f0: 120, f1: 50, dur: 0.25, vol: 0.6 });
    noise(ctx, out, t, { filter: 'bandpass', f0: 1200, f1: 3200, q: 0.8, dur: 0.35, vol: 0.55, attack: 0.01 });
    noise(ctx, out, t + 0.05, { filter: 'highpass', f0: 4000, dur: 0.25, vol: 0.12 });
  },
  // 水柱飛到盡頭散掉：輕輕的「嘶——」
  fizzle(ctx, out, t) {
    noise(ctx, out, t, { filter: 'highpass', f0: 3000, f1: 6000, dur: 0.3, vol: 0.16, attack: 0.02 });
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
  // 蝙蝠的聲波：很高的「吱——」往下滑兩次，帶一點顫音
  sonic(ctx, out, t) {
    for (const [dt, v] of [[0, 0.16], [0.07, 0.09]]) {
      tone(ctx, out, t + dt, { type: 'sine', f0: 5200, f1: 2600, dur: 0.12, vol: v, attack: 0.005 });
      tone(ctx, out, t + dt, { type: 'triangle', f0: 2600, f1: 1300, dur: 0.1, vol: v * 0.5, attack: 0.005 });
    }
    noise(ctx, out, t, { filter: 'highpass', f0: 4000, dur: 0.05, vol: 0.06 });
  },
  // 鐘乳石斷掉：清脆的「喀」＋碎石往下灑
  crack(ctx, out, t) {
    noise(ctx, out, t, { filter: 'bandpass', f0: 3200, f1: 1800, q: 1.2, dur: 0.07, vol: 0.55 });
    tone(ctx, out, t, { type: 'square', f0: 900, f1: 300, dur: 0.05, vol: 0.08 });
    noise(ctx, out, t + 0.06, { filter: 'bandpass', f0: 1200, f1: 500, q: 0.8, dur: 0.35, vol: 0.18 });
  },
  // 獨眼巨人的震盪獅吼：低沉沙啞的「吼——」（幾個走音的鋸齒波往下掉）＋一大片轟隆的風聲，拖一秒多
  roar(ctx, out, t) {
    for (const [f, v] of [[96, 0.12], [101, 0.1], [148, 0.05]]) tone(ctx, out, t, { type: 'sawtooth', f0: f, f1: f * 0.62, dur: 1.1, vol: v, attack: 0.08 });
    noise(ctx, out, t, { filter: 'lowpass', f0: 1400, f1: 200, dur: 1.2, vol: 0.55, attack: 0.06 });
    noise(ctx, out, t + 0.05, { filter: 'bandpass', f0: 600, f1: 260, q: 0.9, dur: 0.9, vol: 0.3, attack: 0.05 });
  },
  // 獨眼巨人砸下東西（超巨石落地、倒下）：很低的「咚」＋岩石震動的悶響，拖得比較長
  stomp(ctx, out, t) {
    tone(ctx, out, t, { type: 'sine', f0: 70, f1: 28, dur: 0.8, vol: 0.95 });
    noise(ctx, out, t, { filter: 'lowpass', f0: 900, f1: 90, dur: 0.9, vol: 0.7 });
    noise(ctx, out, t + 0.12, { filter: 'bandpass', f0: 420, f1: 160, q: 0.7, dur: 0.7, vol: 0.25 });   // 碎石落下
  },
  // 獨眼巨人丟巨石：用力的「嘿」＋破風聲
  heave(ctx, out, t) {
    tone(ctx, out, t, { type: 'sawtooth', f0: 140, f1: 95, dur: 0.18, vol: 0.08, attack: 0.02 });
    noise(ctx, out, t + 0.05, { filter: 'bandpass', f0: 500, f1: 1600, q: 0.8, dur: 0.3, vol: 0.3, attack: 0.03 });
  },
  // 火把點燃：「呼」的一聲火燒起來
  ignite(ctx, out, t) {
    noise(ctx, out, t, { filter: 'lowpass', f0: 600, f1: 2400, dur: 0.35, vol: 0.4, attack: 0.04 });
    tone(ctx, out, t, { type: 'sine', f0: 90, f1: 140, dur: 0.3, vol: 0.12, attack: 0.04 });
  },
  // 流浪劍士拔刀（一閃、劍氣發動）：刀出鞘的「鏘——」（高頻的金屬聲拖一下）＋ 一刀劃過去的破風聲
  iai(ctx, out, t) {
    noise(ctx, out, t, { filter: 'highpass', f0: 2600, f1: 6000, dur: 0.12, vol: 0.35, attack: 0.004 });
    for (const [f, v] of [[2960, 0.07], [4410, 0.04]]) tone(ctx, out, t + 0.03, { type: 'sine', f0: f, f1: f * 0.98, dur: 0.6, vol: v });
    noise(ctx, out, t + 0.06, { filter: 'bandpass', f0: 1800, f1: 600, q: 0.9, dur: 0.22, vol: 0.25 });
  },
  // 流浪劍士格擋：刀身擋住一下的「噹」（兩個不和諧的金屬音）
  clang(ctx, out, t) {
    for (const [f, v] of [[1240, 0.12], [1873, 0.08], [2650, 0.04]]) tone(ctx, out, t, { type: 'triangle', f0: f, f1: f * 0.97, dur: 0.35, vol: v });
    noise(ctx, out, t, { filter: 'bandpass', f0: 3500, q: 1.5, dur: 0.05, vol: 0.25 });
  },
  // 天狗搧風（風彈、羽刃飛過去、風彈炸開）：一陣「呼——」的風聲（帶通的雜訊往上掃再落下）
  gust(ctx, out, t) {
    noise(ctx, out, t, { filter: 'bandpass', f0: 300, f1: 1400, q: 0.7, dur: 0.45, vol: 0.45, attack: 0.06 });
    noise(ctx, out, t + 0.2, { filter: 'bandpass', f0: 1400, f1: 500, q: 0.8, dur: 0.4, vol: 0.25 });
    tone(ctx, out, t, { type: 'sine', f0: 180, f1: 120, dur: 0.4, vol: 0.05, attack: 0.05 });
  },
  // 天狗的羽毛射出去：很輕很短的「咻」
  feather(ctx, out, t) {
    noise(ctx, out, t, { filter: 'highpass', f0: 2500, f1: 5000, dur: 0.12, vol: 0.22, attack: 0.01 });
    tone(ctx, out, t, { type: 'sine', f0: 1800, f1: 900, dur: 0.1, vol: 0.03 });
  },
  // 大樹遊俠放箭（貫穿箭、箭雨）：弓弦「嘣」的一聲（低音往下滑、帶一點顫）＋ 箭破風的「咻」
  bow(ctx, out, t) {
    tone(ctx, out, t, { type: 'triangle', f0: 220, f1: 120, dur: 0.22, vol: 0.18, attack: 0.003 });
    tone(ctx, out, t, { type: 'sine', f0: 440, f1: 260, dur: 0.12, vol: 0.06, attack: 0.003 });
    noise(ctx, out, t + 0.02, { filter: 'highpass', f0: 1800, f1: 4200, dur: 0.18, vol: 0.2, attack: 0.01 });
  },
  // 藤蔓陷阱（放下、困住人、被打斷）：葉子沙沙響 ＋ 藤蔓拉緊的「啪」
  snare(ctx, out, t) {
    noise(ctx, out, t, { filter: 'bandpass', f0: 1600, f1: 900, q: 0.9, dur: 0.28, vol: 0.22, attack: 0.02 });
    noise(ctx, out, t + 0.12, { filter: 'bandpass', f0: 2400, q: 1.4, dur: 0.05, vol: 0.4 });
    tone(ctx, out, t + 0.12, { type: 'square', f0: 320, f1: 180, dur: 0.06, vol: 0.05 });
  },
  // 調皮妖精（閃現、星屑彈、調包、咬耳朵）：一串亮亮的「叮鈴鈴」往上滑（像搖鈴）
  twinkle(ctx, out, t) {
    [1568, 2093, 2637, 3136].forEach((f, i) => tone(ctx, out, t + i * 0.045, { type: 'sine', f0: f, f1: f * 1.02, dur: 0.18, vol: 0.07 }));
    noise(ctx, out, t, { filter: 'highpass', f0: 6000, dur: 0.2, vol: 0.05, attack: 0.02 });
  },
  // 分身被打破：「啵」一聲炸開 ＋ 一陣往下掉的叮鈴（像泡泡破掉）
  pop(ctx, out, t) {
    tone(ctx, out, t, { type: 'sine', f0: 900, f1: 180, dur: 0.12, vol: 0.25, attack: 0.002 });
    noise(ctx, out, t, { filter: 'bandpass', f0: 1200, q: 0.8, dur: 0.18, vol: 0.35 });
    [2637, 2093, 1568].forEach((f, i) => tone(ctx, out, t + 0.08 + i * 0.05, { type: 'sine', f0: f, dur: 0.12, vol: 0.05 }));
  },
  // 魅惑：兩個音「嗚～」往上又往下的甜甜的滑音
  charm(ctx, out, t) {
    tone(ctx, out, t, { type: 'sine', f0: 660, f1: 990, dur: 0.25, vol: 0.12, attack: 0.03 });
    tone(ctx, out, t + 0.22, { type: 'sine', f0: 990, f1: 740, dur: 0.35, vol: 0.1, attack: 0.02 });
  },

  // 頑皮猴王（丟東西、盪樹枝、生氣）：猴子叫「嗚嗚、啊啊」兩聲往上衝的短促叫聲
  ook(ctx, out, t) {
    [[420, 760, 0], [480, 900, 0.13]].forEach(([f0, f1, dt]) => {
      tone(ctx, out, t + dt, { type: 'sawtooth', f0, f1, dur: 0.09, vol: 0.07, attack: 0.01 });
      tone(ctx, out, t + dt, { type: 'sine', f0: f0 * 2, f1: f1 * 2, dur: 0.08, vol: 0.05, attack: 0.01 });
    });
  },
  // 猴王接住砲彈：「啪」一聲拍在手掌上（短促的雜訊 ＋ 悶悶的一下）
  snatch(ctx, out, t) {
    noise(ctx, out, t, { filter: 'bandpass', f0: 1800, q: 0.9, dur: 0.07, vol: 0.45 });
    tone(ctx, out, t, { type: 'triangle', f0: 220, f1: 110, dur: 0.09, vol: 0.18 });
  },
  // 踩到香蕉皮：卡通的滑音一路往下「咻～」，最後「咚」一下
  slip(ctx, out, t) {
    tone(ctx, out, t, { type: 'sine', f0: 1400, f1: 260, dur: 0.38, vol: 0.12, attack: 0.01 });
    tone(ctx, out, t + 0.38, { type: 'triangle', f0: 140, f1: 70, dur: 0.12, vol: 0.2 });
  },

  // 大地之母・蓋亞的巨掌・捏碎：兩隻石手拍在一起的「啪碰！」（很重的低音 ＋ 一聲乾脆的拍擊 ＋ 碎石灑下來）
  clap(ctx, out, t) {
    noise(ctx, out, t, { filter: 'bandpass', f0: 1400, f1: 700, q: 0.8, dur: 0.12, vol: 0.7 });
    tone(ctx, out, t, { type: 'sine', f0: 90, f1: 35, dur: 0.6, vol: 0.9 });
    noise(ctx, out, t + 0.02, { filter: 'lowpass', f0: 800, f1: 120, dur: 0.6, vol: 0.5 });
    noise(ctx, out, t + 0.12, { filter: 'bandpass', f0: 500, f1: 200, q: 0.7, dur: 0.5, vol: 0.2 });
  },
  // 撿到自然之花 / 光球飛進祭壇：一聲清亮的鈴「叮——」（兩個泛音）
  chime(ctx, out, t) {
    for (const [f, v] of [[1319, 0.12], [1976, 0.06], [2637, 0.03]]) tone(ctx, out, t, { type: 'sine', f0: f, dur: 0.6, vol: v, attack: 0.005 });
  },
  // 祭壇淨化 / 護盾張開 / 最後之光：一個大三和弦慢慢湧上來再散開（像詩班的「啊——」），上面灑一點亮亮的雜訊
  purify(ctx, out, t) {
    for (const [f, v] of [[523, 0.09], [659, 0.07], [784, 0.07], [1047, 0.05]]) {
      tone(ctx, out, t, { type: 'triangle', f0: f, f1: f * 1.005, dur: 1.1, vol: v, attack: 0.25 });
    }
    noise(ctx, out, t + 0.1, { filter: 'highpass', f0: 5000, dur: 0.8, vol: 0.05, attack: 0.2 });
  },
  // 大地震動（蓋亞暴走、誅滅的預兆、倒下）：很長的低頻轟隆聲
  quake(ctx, out, t) {
    noise(ctx, out, t, { filter: 'lowpass', f0: 260, f1: 70, dur: 1.6, vol: 0.9, attack: 0.15 });
    tone(ctx, out, t, { type: 'sine', f0: 48, f1: 32, dur: 1.5, vol: 0.6, attack: 0.15 });
    noise(ctx, out, t + 0.3, { filter: 'bandpass', f0: 380, f1: 150, q: 0.7, dur: 1.1, vol: 0.18, attack: 0.1 });
  },
  // 誅滅：光落下來的一聲巨響（高頻的「鏘」＋ 很重的爆炸低音 ＋ 拖長的殘響）
  judge(ctx, out, t) {
    noise(ctx, out, t, { filter: 'highpass', f0: 3000, f1: 8000, dur: 0.4, vol: 0.35 });
    for (const [f, v] of [[880, 0.08], [1320, 0.05]]) tone(ctx, out, t, { type: 'sine', f0: f, f1: f * 0.98, dur: 1.4, vol: v });
    tone(ctx, out, t, { type: 'sine', f0: 70, f1: 25, dur: 1.2, vol: 1 });
    noise(ctx, out, t, { filter: 'lowpass', f0: 1200, f1: 80, dur: 1.4, vol: 0.8 });
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
