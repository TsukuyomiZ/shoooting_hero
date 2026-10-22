import { STICKERS, allowSticker } from '../shared/social/stickers.js';
import { LANES, laneTopPct, pickLane } from './danmaku-lanes.js';

// 反應貼圖：右下角一排按鈕，按下去貼圖像彈幕一樣從畫面右邊飄到左邊（所有人都看得到）
// DOM 疊在 canvas 上（跟著 canvas 縮放），不畫進 canvas，選牌畫面打開時也照樣飄
// 只用頂部 HUD 正下方的三排軌道（client/danmaku-lanes.js），不擋到底下的戰場：
// 新的一則放進最早能放的那排（好幾排空著就放最上面那排）；三排都滿了就排隊，等最早空出來的那排
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
    this.lanes = Array(LANES).fill(null);        // 每一排最後放的那則 { at, w, v }（performance.now、寬 px、速度 px/ms）
    this.pending = [];                           // 排隊等著出場的 { from, sticker 或 text, at }
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

  // 收到別人的貼圖（或自己剛按的）：排進隊伍，有一排空出來就出場
  spawn(from, id) {
    const sticker = BY_ID.get(id);
    if (!sticker) return;
    if (from !== this.myId && this.pending.length >= MAX_PENDING) return;
    this.pending.push({ from, sticker, at: performance.now() });
    this.pump();
  }

  // 聊天訊息（client/chat.js）：跟貼圖排同一個隊伍、共用三排軌道；伺服器有洗版限制，所以不受排隊上限影響（不丟別人的話）
  spawnText(from, text) {
    if (!text) return;
    this.pending.push({ from, text, at: performance.now() });
    this.pump();
  }

  // 隊伍最前面那則：量好寬度，放進最早能放的那排；三排都還不能放就等到最早空出來的那排（照順序出場）
  pump() {
    if (this.pumpTimer) return;
    for (;;) {
      const now = performance.now();
      while (this.pending.length && now - this.pending[0].at > STALE_MS) this.pending.shift();
      const next = this.pending[0];
      if (!next) return;
      next.node ||= this.build(next);
      this.syncLayer();
      this.danmaku.append(next.node);   // 還沒設 top / 動畫：待在畫面右邊外面（看不到），先量寬度
      const W = this.danmaku.clientWidth;
      const w = next.node.offsetWidth;
      if (!W || !w) { next.node.remove(); this.pending.shift(); continue; }   // 畫面還沒排版（大小是 0）：不播，也不要把軌道卡死
      const { lane, at } = pickLane(this.lanes, now, w, W, FLY_MS, GAP_PX);
      if (at > now) {   // 先拿下來，出場時再放上去（貼圖彈出來的動畫才會從頭播）
        next.node.remove();
        this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump(); }, at - now);
        return;
      }
      this.pending.shift();
      this.launch(next.node, lane, now, W, w);
    }
  }

  launch(node, lane, now, W, w) {
    node.style.top = `${laneTopPct(lane)}%`;
    const speed = (W + w) / FLY_MS;   // px / ms
    this.lanes[lane] = { at: now, w, v: speed };
    const anim = node.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-(W + w)}px)` }], { duration: FLY_MS, easing: 'linear' });
    anim.onfinish = () => node.remove();
    anim.oncancel = () => node.remove();
  }

  // 一則彈幕的 DOM（還沒放進畫面）：貼圖是圖在前、名字在後；聊天是名字在前、字在後
  build({ from, sticker: s, text }) {
    const { name, color } = this.who(from);
    const item = el('div', 'dm');
    if (from === this.myId) item.classList.add('mine');
    const tag = el('span', 'dm-name');
    tag.textContent = name;
    tag.style.color = color;
    if (s) {
      const img = el('img');
      img.src = s.src;
      img.alt = s.label;
      item.append(img, tag);
    } else {   // 聊天：名字在前、字在後
      item.classList.add('text');
      const words = el('span', 'dm-text');
      words.textContent = text;
      item.append(tag, words);
    }
    return item;
  }
}

// 重新播一次按鈕的 CSS 動畫（連點也每次都會動）
function replay(node, cls) {
  node.classList.remove('pressed', 'blocked');
  void node.offsetWidth;
  node.classList.add(cls);
}
