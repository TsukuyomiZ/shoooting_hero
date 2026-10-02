// 背景音樂（Web Audio）：整首解碼後循環播放、換曲時交叉淡入淡出。走 audio.js 的「音樂」匯流排（設定面板調音量）。
// 曲子放 assets/music/；要換曲或調整兩首之間的相對音量改這張表就好。哪一關放哪首見 GameView.musicTrack()
import { audio } from './audio.js';
import { LeafAmbience } from './ambience.js';
import { snakeHiss } from './sfx.js';

// leaves = 疊一層合成的樹葉沙沙聲（ambience.js），數字是它的音量倍率；一樣吃「音樂」音量、跟著曲子淡入淡出
// intro: 'hiss' = 換到這首時前一首很快收掉，先播一聲合成的蛇哈氣（sfx.js 的 snakeHiss，走「音樂」音量），音樂接著淡入
const TRACKS = {
  normal: { src: 'assets/music/canyon-echoes.mp3', volume: 0.7 },   // 小關
  fever: { src: 'assets/music/canyon-fever.mp3', volume: 0.7 },     // 小關狂熱生效後
  tree: { src: 'assets/music/guardian-of-the-canopy.mp3', volume: 0.7 },   // 古樹之庭（使用者選原曲，不疊樹葉聲；要的話加 leaves: 1）
  snake: { src: 'assets/music/savage-jungle-menace.mp3', volume: 0.7, intro: 'hiss' },   // 叢林巨蟒
};
const HISS = { at: 0.6, vol: 0.25, musicAt: 1.9, musicFade: 1.5, prevFade: 0.8 };   // 哈氣在第幾秒、多大聲；音樂第幾秒開始、淡入幾秒；前一首幾秒收掉
const PRELOAD = { normal: ['fever'], fever: ['normal'] };   // 放這首時先把哪幾首解碼起來（狂熱一來就能馬上換）；其他曲子用到才載，不佔記憶體
const FADE = 2;                    // 換曲 / 停止的淡入淡出秒數

export class Music {
  constructor() {
    this.buffers = new Map();      // key → Promise<AudioBuffer>
    this.want = null;              // 現在應該放的曲子（null = 安靜）
    this.cur = null;               // 正在放的 { key, src, gain }
  }

  // 每幀呼叫都可以：曲子沒變就什麼都不做
  play(key) {
    if (key === this.want) return;
    this.want = key;
    if (!key) { this.fadeOut(); return; }
    if (!audio.ensure()) return;
    this.load(key).then((buf) => { if (this.want === key) this.start(key, buf); })
      .catch((err) => console.warn('背景音樂載入失敗', TRACKS[key].src, err));
    for (const k of PRELOAD[key] || []) this.load(k).catch(() => {});
  }

  load(key) {
    if (!this.buffers.has(key)) {
      const p = fetch(TRACKS[key].src)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
        .then((ab) => audio.ctx.decodeAudioData(ab));
      p.catch(() => this.buffers.delete(key));   // 失敗的話下次再試
      this.buffers.set(key, p);
    }
    return this.buffers.get(key);
  }

  start(key, buf) {
    if (this.cur && this.cur.key === key) return;
    const ctx = audio.ctx;
    const now = ctx.currentTime;
    let at = now, fade = FADE;
    if (TRACKS[key].intro === 'hiss') {
      this.fadeOut(HISS.prevFade);
      snakeHiss(ctx, audio.bus('music'), now + HISS.at, HISS.vol);
      at = now + HISS.musicAt;
      fade = HISS.musicFade;
    } else {
      this.fadeOut();
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(TRACKS[key].volume, at + fade);
    gain.connect(audio.bus('music'));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;               // 曲尾本身就淡出了，直接接回開頭
    src.connect(gain);
    src.start(at);
    let amb = null;
    if (TRACKS[key].leaves) {
      amb = new LeafAmbience(ctx, gain, TRACKS[key].leaves);
      amb.start();
    }
    this.cur = { key, src, gain, amb };
    // 用不到的曲子放掉解碼後的資料（一首兩三分鐘就幾十 MB）；還在淡出的那首自己留著參照，不受影響
    for (const k of [...this.buffers.keys()]) if (k !== key && !(PRELOAD[key] || []).includes(k)) this.buffers.delete(k);
  }

  fadeOut(dur = FADE) {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    const now = audio.ctx.currentTime;
    c.gain.gain.cancelScheduledValues(now);
    c.gain.gain.setValueAtTime(c.gain.gain.value, now);
    c.gain.gain.linearRampToValueAtTime(0, now + dur);
    c.src.stop(now + dur + 0.05);
    if (c.amb) c.amb.stop(now + dur + 0.05);
  }
}
