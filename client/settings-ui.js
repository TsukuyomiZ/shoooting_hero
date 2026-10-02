import { CONFIG } from '../shared/config.js';
import { audio } from './audio.js';
import { sfx } from './sfx.js';

// 音量設定：右上角隊伍面板標題列右邊的喇叭按鈕，按下去打開面板（音樂 / 音效兩條滑桿，0~100，會記住）。
// DOM 疊在 canvas 上、跟著 canvas 縮放（同 stickers.js 的做法）；面板開著時底下墊一層透明遮罩，
// 點面板外面只會關掉面板，不會穿過去變成瞄準 / 開火
const W = CONFIG.WORLD_W, H = CONFIG.WORLD_H;
const BTN = { right: 18, top: 16, size: 24 };   // 世界座標（1024 × 768）：隊伍面板（右上 250 寬）的標題列
const ROWS = [
  { kind: 'music', label: '音樂' },
  { kind: 'sfx', label: '音效' },
];
const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>
  <g class="waves"><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19.5 5.5a9 9 0 0 1 0 13"/></g>
  <g class="mute"><path d="M16 9l6 6M22 9l-6 6"/></g>
</svg>`;

const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const cqw = (px) => `${(px / W) * 100}cqw`;
const cqh = (px) => `${(px / H) * 100}cqh`;

export class SettingsUi {
  constructor(canvas) {
    this.canvas = canvas;
    this.layer = el('div', 'settings-layer');

    this.btn = el('button', 'vol-btn');
    this.btn.type = 'button';
    this.btn.title = '音量設定';
    this.btn.tabIndex = -1;
    this.btn.innerHTML = ICON;
    Object.assign(this.btn.style, { right: cqw(BTN.right), top: cqh(BTN.top), width: cqw(BTN.size), height: cqw(BTN.size) });
    this.btn.hidden = true;
    this.btn.addEventListener('mousedown', (ev) => ev.preventDefault());   // 不搶焦點：之後按空白鍵才不會又按到它
    this.btn.addEventListener('click', () => (this.panel.hidden ? this.open() : this.close()));

    this.backdrop = el('div', 'vol-backdrop');
    this.backdrop.hidden = true;
    this.backdrop.addEventListener('pointerdown', (ev) => { ev.preventDefault(); this.close(); });

    this.panel = el('div', 'vol-panel');
    this.panel.hidden = true;
    Object.assign(this.panel.style, { right: cqw(BTN.right), top: cqh(BTN.top + BTN.size + 8) });
    const title = el('div', 'vol-title');
    title.textContent = '音量';
    this.panel.append(title);
    this.inputs = {};
    this.values = {};
    for (const r of ROWS) {
      const row = el('label', 'vol-row');
      const name = el('span', 'vol-name');
      name.textContent = r.label;
      const input = el('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '5';
      const val = el('span', 'vol-val');
      input.addEventListener('input', () => audio.setVolume(r.kind, Number(input.value)));
      if (r.kind === 'sfx') input.addEventListener('change', () => sfx.play('cannon'));   // 放開滑桿時試聽一下
      row.append(name, input, val);
      this.panel.append(row);
      this.inputs[r.kind] = input;
      this.values[r.kind] = val;
    }
    const hint = el('div', 'vol-hint');
    hint.textContent = 'M 鍵：音樂靜音 / 恢復';
    this.panel.append(hint);

    this.layer.append(this.backdrop, this.btn, this.panel);
    document.body.append(this.layer);

    audio.onChange(() => this.refresh());   // M 鍵靜音時滑桿也跟著動
    window.addEventListener('keydown', (ev) => { if (ev.code === 'Escape' && !this.panel.hidden) this.close(); });
    const sync = () => this.syncLayer();
    new ResizeObserver(sync).observe(canvas);
    window.addEventListener('resize', sync);
    sync();
    this.refresh();
  }

  // 圖層對齊 canvas 實際顯示的位置與大小（canvas 置中、維持 4:3）
  syncLayer() {
    const r = this.canvas.getBoundingClientRect();
    Object.assign(this.layer.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  refresh() {
    for (const r of ROWS) {
      const v = audio.volume(r.kind);
      this.inputs[r.kind].value = String(v);
      this.values[r.kind].textContent = v ? `${v}%` : '關';
    }
    this.btn.classList.toggle('muted', audio.volume('music') === 0 && audio.volume('sfx') === 0);
  }

  show() { this.btn.hidden = false; }
  hide() { this.btn.hidden = true; this.close(); }

  open() {
    this.refresh();
    this.panel.hidden = false;
    this.backdrop.hidden = false;
  }

  close() {
    this.panel.hidden = true;
    this.backdrop.hidden = true;
    // 焦點留在滑桿上的話，遊戲會把之後的按鍵當成在打字而不理（A / D / 空白鍵都沒反應）
    if (this.panel.contains(document.activeElement)) document.activeElement.blur();
  }
}
