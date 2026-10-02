// 背景音樂（Web Audio）：整首解碼後循環播放、換曲時交叉淡入淡出。走 audio.js 的「音樂」匯流排（設定面板調音量）。
// 曲子放 assets/music/；要換曲或調整兩首之間的相對音量改這張表就好。哪一關放哪首見 GameView.musicTrack()
import { audio } from './audio.js';

const TRACKS = {
  normal: { src: 'assets/music/canyon-echoes.mp3', volume: 0.7 },   // 小關
  fever: { src: 'assets/music/canyon-fever.mp3', volume: 0.7 },     // 小關狂熱生效後
};
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
    for (const k of Object.keys(TRACKS)) this.load(k).catch(() => {});   // 其他曲子先解碼起來，狂熱一來就能馬上換
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
    this.fadeOut();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(TRACKS[key].volume, now + FADE);
    gain.connect(audio.bus('music'));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;               // 曲尾本身就淡出了，直接接回開頭
    src.connect(gain);
    src.start(now);
    this.cur = { key, src, gain };
  }

  fadeOut() {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    const now = audio.ctx.currentTime;
    c.gain.gain.cancelScheduledValues(now);
    c.gain.gain.setValueAtTime(c.gain.gain.value, now);
    c.gain.gain.linearRampToValueAtTime(0, now + FADE);
    c.src.stop(now + FADE + 0.05);
  }
}
