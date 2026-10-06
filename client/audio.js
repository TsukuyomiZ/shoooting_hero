// 共用的 AudioContext：音樂、音效各走一條匯流排（GainNode），音量設定存在 localStorage。
// 音樂見 music.js、音效見 sfx.js、設定面板見 settings-ui.js
const STORE_KEY = 'sh_volume';
const DEFAULTS = { music: 70, sfx: 80 };   // 0~100（滑桿的數字）

class AudioHub {
  constructor() {
    this.ctx = null;
    this.buses = {};
    this.vol = { ...DEFAULTS };
    this.lastMusic = DEFAULTS.music;   // M 鍵靜音後要恢復的音量
    this.listeners = [];
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved) {
        for (const k of Object.keys(DEFAULTS)) if (Number.isFinite(saved[k])) this.vol[k] = clampVol(saved[k]);
      } else if (localStorage.getItem('sh_music_muted') === '1') {
        this.vol.music = 0;   // 舊版只有「音樂開 / 關」
      }
    } catch {}
    if (this.vol.music > 0) this.lastMusic = this.vol.music;
    // 瀏覽器要使用者操作過才肯出聲（例如重新整理後直接重連回遊戲）：之後第一次點擊 / 按鍵再叫醒
    const unlock = () => { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    // 切到別的分頁、縮小視窗時音樂和音效照樣播（多人時等隊友的空檔去做別的事，也聽得到輪到自己的提示音）。
    // 同時開好幾個分頁測多人會好幾份聲音疊在一起：在其他分頁的音量面板把音量拉到 0。
    // 回到這個分頁時，如果瀏覽器自己把它暫停了（例如手機切到背景）就叫醒
    document.addEventListener('visibilitychange', () => {
      if (this.ctx && !document.hidden && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    });
  }

  // 第一次要出聲時才建立（使用者點過「單人練習」之類的按鈕之後建立，瀏覽器才讓它直接播）
  ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    for (const k of Object.keys(DEFAULTS)) {
      const g = this.ctx.createGain();
      g.gain.value = gainOf(this.vol[k]);
      g.connect(this.ctx.destination);
      this.buses[k] = g;
    }
    return this.ctx;
  }

  bus(kind) { return this.ensure() ? this.buses[kind] : null; }
  volume(kind) { return this.vol[kind]; }

  setVolume(kind, v) {
    this.vol[kind] = clampVol(v);
    if (kind === 'music' && this.vol.music > 0) this.lastMusic = this.vol.music;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.vol)); } catch {}
    const g = this.buses[kind];
    if (g) {
      const now = this.ctx.currentTime;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(gainOf(this.vol[kind]), now + 0.08);
    }
    for (const fn of this.listeners) fn(kind, this.vol[kind]);
  }

  // M 鍵：音樂靜音 / 恢復成靜音前的音量。回傳是不是靜音了
  toggleMusic() {
    this.setVolume('music', this.vol.music > 0 ? 0 : this.lastMusic || DEFAULTS.music);
    return this.vol.music === 0;
  }

  onChange(fn) { this.listeners.push(fn); }
}

const clampVol = (v) => Math.max(0, Math.min(100, Math.round(v)));
const gainOf = (v) => (v / 100) ** 2;   // 平方：滑桿拉一半聽起來大約是一半大聲

export const audio = new AudioHub();
