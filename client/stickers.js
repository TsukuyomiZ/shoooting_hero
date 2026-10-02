import { CONFIG } from '../shared/config.js';
import { STICKERS, allowSticker } from '../shared/stickers.js';

// 反應貼圖：右下角一排按鈕，按下去貼圖像彈幕一樣從畫面右邊飄到左邊（所有人都看得到）
// DOM 疊在 canvas 上（跟著 canvas 縮放），不畫進 canvas，選牌畫面打開時也照樣飄
// 只用畫面最上方一條軌道，不擋到底下的戰場；同時太多張就排隊依序出場
const LANE_Y = 112 / CONFIG.WORLD_H;        // 左上回合資訊（含狂熱標籤）、上方武器列的正下方
const FLY_MS = 5200;                        // 飄過整個畫面的時間
const GAP_PX = 24;                          // 前後兩張的最小間距
const MAX_PENDING = 8;                      // 排隊上限：滿了別人的貼圖就丟掉（自己按的一定會播）
const STALE_MS = 8000;                      // 排太久的不播了（例如分頁切到背景時計時器被節流）
const BY_ID = new Map(STICKERS.map(s => [s.id, s]));

const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

export class StickerUi {
  // send(msg)：送給伺服器；who(playerId) → { name, color }
  constructor(canvas, { send, who }) {
    this.canvas = canvas;
    this.send = send;
    this.who = who;
    this.myId = null;
    this.sent = [];                              // 自己最近送出的時間（洗版限制，跟伺服器同一套）
    this.laneFree = 0;                           // 軌道什麼時候可以再放下一張（performance.now）
    this.pending = [];                           // 排隊等著出場的 { from, sticker }
    this.pumpTimer = null;

    this.layer = el('div', 'sticker-layer');
    this.danmaku = el('div', 'danmaku');
    this.bar = el('div', 'sticker-bar');
    this.bar.hidden = true;
    for (const s of STICKERS) {
      const b = el('button', 'sticker-btn');
      b.type = 'button';
      b.title = s.label;
      b.tabIndex = -1;
      const img = el('img');
      img.src = s.src;
      img.alt = s.label;
      img.draggable = false;
      b.append(img);
      b.addEventListener('mousedown', (ev) => ev.preventDefault());   // 不搶焦點：之後按空白鍵才不會又丟一張
      b.addEventListener('click', () => this.fire(s.id, b));
      this.bar.append(b);
    }
    this.layer.append(this.danmaku, this.bar);
    document.body.append(this.layer);

    const sync = () => this.syncLayer();
    new ResizeObserver(sync).observe(canvas);
    window.addEventListener('resize', sync);
    sync();
  }

  // 圖層對齊 canvas 實際顯示的位置與大小（canvas 置中、維持 4:3）
  syncLayer() {
    const r = this.canvas.getBoundingClientRect();
    Object.assign(this.layer.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  show() { this.bar.hidden = false; }
  hide() { this.bar.hidden = true; }

  fire(id, btn) {
    if (!allowSticker(this.sent, Date.now())) {
      replay(btn, 'blocked');
      return;
    }
    replay(btn, 'pressed');
    this.spawn(this.myId, id);   // 自己先播，不等來回
    this.send({ t: 'sticker', id });
  }

  // 收到別人的貼圖（或自己剛按的）：排進隊伍，軌道空出來就出場
  spawn(from, id) {
    const sticker = BY_ID.get(id);
    if (!sticker) return;
    if (from !== this.myId && this.pending.length >= MAX_PENDING) return;
    this.pending.push({ from, sticker, at: performance.now() });
    this.pump();
  }

  pump() {
    if (this.pumpTimer) return;
    const now = performance.now();
    while (this.pending.length && now - this.pending[0].at > STALE_MS) this.pending.shift();
    if (!this.pending.length) return;
    const wait = this.laneFree - now;
    if (wait > 0) {
      this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump(); }, wait);
      return;
    }
    this.launch(this.pending.shift());
    this.pump();
  }

  launch({ from, sticker: s }) {
    const { name, color } = this.who(from);
    const item = el('div', 'dm');
    if (from === this.myId) item.classList.add('mine');
    const img = el('img');
    img.src = s.src;
    img.alt = s.label;
    const tag = el('span', 'dm-name');
    tag.textContent = name;
    tag.style.color = color;
    item.append(img, tag);

    item.style.top = `${LANE_Y * 100}%`;
    this.syncLayer();
    this.danmaku.append(item);

    const W = this.danmaku.clientWidth;
    const w = item.offsetWidth;
    if (!W || !w) { item.remove(); return; }   // 畫面還沒排版（大小是 0）：不播，也不要把軌道卡死
    const speed = (W + w) / FLY_MS;   // px / ms
    this.laneFree = performance.now() + (w + GAP_PX) / speed;
    const anim = item.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-(W + w)}px)` }], { duration: FLY_MS, easing: 'linear' });
    anim.onfinish = () => item.remove();
    anim.oncancel = () => item.remove();
  }
}

// 重新播一次按鈕的 CSS 動畫（連點也每次都會動）
function replay(node, cls) {
  node.classList.remove('pressed', 'blocked');
  void node.offsetWidth;
  node.classList.add(cls);
}
