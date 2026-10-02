import { CONFIG } from '../shared/config.js';
import { SNAKE_ACTION_NAMES, chargeLane } from '../shared/snake-boss.js';
import { VINE_HAND } from '../shared/entities.js';
import { clamp } from '../shared/utils.js';
import { text } from './draw.js';

// 叢林巨蟒的客戶端：巨蟒回合的動畫腳本（照伺服器廣播的招式播）與巨蟒 / 藤蔓 / 解藥 / 招式 / 叢林背景的繪圖。
const FPS = 60;
const SCALE = '#5f7a2c', SCALE_DARK = '#3b4a1a', BELLY = '#c8b878', BLOTCH = '#2f2a14';
const POISON = '#c084fc';

// ---------- 動畫腳本 ----------

// 巨蟒的回合：預兆（衝撞：往後縮、警示帶快閃；噴灑：抬頭張嘴；震擊：抬頭再砸進水裡；撕咬：往後縮、眼睛發光）
// → 出招（照 shotScript 重播；衝撞 / 撕咬時頭跟著飛行物衝出去）→ 校正成伺服器結果。
// view.snakeFx 給畫面用：{ action, t, phase: 'cast' | 'act', targetId }。
// 全部播完才換上伺服器預定的下一招（msg.boss.next）：衝撞的警示帶留到真的撞下去，新的在巨蟒回合之後才出現
export function* snakeTurnScript(view, msg) {
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* snakeStepScript(view, step);
  view.snakeFx = null;
  if (view.match.snake && msg.boss.next !== undefined) view.match.snake.next = msg.boss.next;
}

function* snakeStepScript(view, b) {
  const match = view.match;
  const def = match.snake ? match.snake.def : null;
  const fx = view.snakeFx = { action: b.action, t: 0, phase: 'cast', targetId: b.targetId ?? null };
  const cast = Math.round(CONFIG.TIMING.bossCast * FPS);
  const name = SNAKE_ACTION_NAMES[b.action] || '';
  const target = b.targetId ? match.byId(b.targetId) : null;
  if (b.action === 'idle') view.showBanner(SNAKE_ACTION_NAMES.idle, '#d9f99d');
  else view.showBanner(`巨蟒：${name}${target ? ` → ${target.name}` : ''}！`, b.action === 'charge' ? '#fca5a5' : b.action === 'quake' ? '#fdba74' : POISON);
  const slam = Math.round(cast * 0.78);
  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    if (b.action === 'charge' && i % 8 === 0) view.shake = Math.max(view.shake, 2);
    if (b.action === 'spray' && def && i % 3 === 0) {   // 毒液在嘴邊聚起來
      const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 25;
      const o = def.mouth;
      view.particles.push({ x: o.x + Math.cos(a) * r, y: o.y + Math.sin(a) * r, vx: -Math.cos(a) * r * 2.2, vy: -Math.sin(a) * r * 2.2, life: 0.4, maxLife: 0.4, size: 3, color: Math.random() < 0.5 ? '#a855f7' : '#86efac', gravity: 0 });
    }
    if (b.action === 'quake' && i === slam) {   // 頭砸進水裡：大水花、整個畫面震
      view.shake = Math.max(view.shake, 16);
      for (let x = 620; x <= 1000; x += 60) view.splash(x);
      if (def) view.spawnParticles(def.bridge.x1 - 10, def.bridge.y, 16, { speed: 160, life: 0.6, size: 3, color: '#4d7c0f', gravity: 500 });
    }
    yield { frames: 1 };
  }
  fx.phase = 'act';
  if (b.action === 'quake') view.shake = Math.max(view.shake, 10);
  if (b.shot) {
    yield* view.shotScript(b.shot);
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }
}

// 巨蟒倒下：回傳 true 表示處理過了（不要再顯示一般的「被擊倒」橫幅）
export function onSnakeDeath(view, e) {
  if (e.part !== 'snake') return false;
  view.showBanner('叢林巨蟒倒下了！', '#fde047');
  view.shake = Math.max(view.shake, 14);
  view.spawnParticles(e.x - e.hw * 0.6, e.cy, 40, { speed: 240, life: 1.2, size: 4, color: '#65a30d', gravity: 250 });
  for (let x = 620; x <= 1000; x += 50) view.splash(x);
  return true;
}

// 解藥從巨蟒嘴裡掉出來（事件 / 回合結束效果帶來的 drops）：加進場上，畫面上用 0.7 秒的拋物線飛到落點
export function addDrops(view, drops) {
  const match = view.match;
  if (!match || !drops) return;
  const from = match.snake ? match.snake.def.mouth : { x: 600, y: 500 };
  drops.forEach((d, k) => {
    if (match.items.some(it => it.id === d.id)) return;
    match.items.push({ ...d, anim: { x: from.x, y: from.y - 20, t0: view.time + k * 0.12 } });
  });
  view.floatText(match.byId('snake') || { cx: from.x, y: from.y, h: 0, id: 'snake' }, drops.length > 1 ? `掉出解藥 ×${drops.length}` : '掉出解藥', '#6ee7b7', 16);
}

// ---------- 繪圖：場景 ----------

// 藤蔓、水裡的蛇身、解藥、預定衝撞的警示帶（地形之後、角色之前畫）
export function drawSnakeScene(ctx, view) {
  const match = view.match;
  if (!match || !match.snake) return;
  drawCoils(ctx, view);
  drawCanopy(ctx);
  match.terrain.vines.forEach((v, i) => drawVine(ctx, v, i, view.time));
  for (const it of match.items) drawItem(ctx, it, view);

  const snake = match.byId('snake');
  const next = match.snake.next;
  const fx = view.snakeFx;
  if (!snake || !snake.alive) return;
  // 預定的巨蟒衝撞：玩家回合一直標著範圍（慢慢呼吸），巨蟒出招前快閃；真的衝出去之後就不畫了（頭本身就是範圍）
  if (fx && fx.action === 'charge') {
    if (fx.phase === 'cast') drawChargeBand(ctx, match, 0.22 + 0.14 * Math.sin(fx.t * 16), 1, view.time);
  } else if (next && next.action === 'charge') {
    drawChargeBand(ctx, match, 0.16 + 0.06 * Math.sin(view.time * 3), 0.9, view.time);
  }
}

// 巨蟒衝撞的警示帶：頭的上緣到水面、嘴前到地圖左邊（跟伺服器的衝撞同一個範圍，見 chargeLane），上緣一條虛線 + 往左跑的箭頭
function drawChargeBand(ctx, match, alpha, lineAlpha, time) {
  const lane = chargeLane(match);
  const bottom = CONFIG.WATER_LEVEL;
  ctx.save();
  ctx.fillStyle = `rgba(239,68,68,${alpha})`;
  ctx.fillRect(lane.x0, lane.top, lane.x1 - lane.x0, bottom - lane.top);
  ctx.strokeStyle = `rgba(252,165,165,${lineAlpha})`;
  ctx.setLineDash([10, 8]);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(lane.x0, lane.top); ctx.lineTo(lane.x1, lane.top); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = `rgba(254,202,202,${lineAlpha * 0.7})`;
  ctx.lineWidth = 3;
  const y = lane.top + 34;
  const off = (time * 90) % 60;
  for (let x = lane.x1 - 20 - off; x > 20; x -= 60) {
    ctx.beginPath(); ctx.moveTo(x + 8, y - 9); ctx.lineTo(x, y); ctx.lineTo(x + 8, y + 9); ctx.stroke();
  }
  ctx.restore();
}

// 上方一排茂密的樹冠（藤蔓從這裡垂下來；大半被上方 HUD 蓋住）
function drawCanopy(ctx) {
  for (let x = -20; x < 760; x += 46) {
    const y = 6 + ((x * 7) % 13), r = 30 + ((x * 3) % 14);
    ctx.fillStyle = 'rgba(16,48,22,0.95)';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(52,104,40,0.75)';
    ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.2, r * 0.55, 0, Math.PI * 2); ctx.fill();
  }
}

// 一條藤蔓：從畫面上方垂到 bottom 再多一小截，微微彎曲（抓著的人對齊 v.x，所以彎的幅度很小）、兩側交錯長葉子
function drawVine(ctx, v, i, time) {
  const end = v.bottom + 10;
  const wob = (y) => v.x + Math.sin(y * 0.045 + i * 1.7) * 2.5 * (y / end) + Math.sin(time * 1.2 + i) * 1.2 * (y / end);
  ctx.save();
  ctx.lineCap = 'round';
  for (const [w, color] of [[7, '#1f3d14'], [4.5, '#3f6b22'], [1.5, 'rgba(163,209,108,0.6)']]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    for (let y = 0; y <= end; y += 8) (y ? ctx.lineTo(wob(y), y) : ctx.moveTo(wob(0), 0));
    ctx.stroke();
  }
  for (let y = 40 + (i * 11) % 20, k = 0; y < end - 6; y += 26, k++) {
    const side = k % 2 ? 1 : -1;
    const x = wob(y);
    ctx.fillStyle = k % 3 ? '#4d7c0f' : '#65a30d';
    ctx.beginPath();
    ctx.ellipse(x + side * 7, y + 2, 7, 3.2, side * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// 水裡露出來的蛇身（一段段拱起來的身體，只畫水面以上；不是判定，子彈打到水就沒了）
function drawCoils(ctx, view) {
  const snake = view.match.byId('snake');
  const sink = snake && !snake.alive ? Math.min(60, snake.deathTimer * 40) : 0;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, CONFIG.WORLD_W, CONFIG.WATER_LEVEL + 2); ctx.clip();
  for (const [x, r, ph] of [[700, 46, 0], [835, 58, 1.3], [985, 64, 2.4]]) {
    const y = CONFIG.WATER_LEVEL + 22 + Math.sin(view.time * 1.4 + ph) * 3 + sink;
    const g = ctx.createLinearGradient(0, y - r, 0, y);
    g.addColorStop(0, '#7a9638');
    g.addColorStop(1, SCALE_DARK);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(x, y, r * 1.5, r, 0, Math.PI, 0); ctx.fill();
    ctx.fillStyle = BLOTCH;
    for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.ellipse(x + k * r * 0.8, y - r * 0.6 + Math.abs(k) * 10, 10, 6, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

// 解藥瓶：玻璃瓶 + 發亮的綠色藥水 + 軟木塞，輕輕上下浮動。剛掉出來的沿拋物線飛過去（it.anim）
function drawItem(ctx, it, view) {
  let x = it.x, y = it.y;
  if (it.anim) {   // 照 view.time 算進度（跟畫面更新率無關）
    const raw = (view.time - it.anim.t0) / 0.7;
    if (raw >= 1) delete it.anim;
    else {
      if (raw <= 0) return;
      const t = clamp(raw, 0, 1);
      x = it.anim.x + (it.x - it.anim.x) * t;
      y = it.anim.y + (it.y - it.anim.y) * t - Math.sin(t * Math.PI) * 110;
    }
  }
  drawAntidote(ctx, x, y - 2 + (it.anim ? 0 : Math.sin(view.time * 3 + it.x) * 1.5), view.time);
}

export function drawAntidote(ctx, x, y, time) {
  const glow = 0.35 + 0.25 * Math.sin(time * 4 + x);
  ctx.save();
  ctx.fillStyle = `rgba(110,231,183,${glow * 0.5})`;
  ctx.beginPath(); ctx.arc(x, y - 9, 13, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(220,252,231,0.35)';   // 瓶身
  ctx.strokeStyle = 'rgba(236,253,245,0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x, y - 7, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#34d399';                   // 藥水
  ctx.beginPath(); ctx.arc(x, y - 7, 5.5, 0.15 * Math.PI, 0.85 * Math.PI); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y - 7, 5.5, 0, Math.PI); ctx.fill();
  ctx.fillStyle = 'rgba(220,252,231,0.5)';     // 瓶頸
  ctx.fillRect(x - 2.5, y - 18, 5, 5);
  ctx.strokeRect(x - 2.5, y - 18, 5, 5);
  ctx.fillStyle = '#a16207';                   // 軟木塞
  ctx.fillRect(x - 3, y - 21, 6, 4);
  ctx.fillStyle = '#fff';                      // 反光
  ctx.beginPath(); ctx.arc(x - 2.5, y - 9.5, 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 血條旁的中毒標記：紫色毒液滴 + 層數（還沒結算的；自己的回合開始時結算）
export function drawPoisonMark(ctx, x, y, stacks) {
  ctx.save();
  ctx.fillStyle = '#a855f7';
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - 7);
  ctx.quadraticCurveTo(x + 5.5, y - 0.5, x + 4, y + 3);
  ctx.arc(x, y + 2, 4.2, 0.2, Math.PI - 0.2);
  ctx.quadraticCurveTo(x - 5.5, y - 0.5, x, y - 7);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath(); ctx.arc(x - 1.5, y + 1, 1.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  text(ctx, String(stacks), x + 6, y + 5, { size: 11, bold: true, color: '#e9d5ff', outline: 'rgba(0,0,0,0.9)' });
}

// 抓著藤蔓的人：兩隻手往上握住藤蔓（在角色座標裡，跟身體一起縮放）
export function drawVineHands(ctx, e) {
  const s = e.h / 30;
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.scale(s, s);
  ctx.strokeStyle = '#ffd9b3';
  ctx.lineCap = 'round';
  ctx.lineWidth = 3;
  const hy = -30 + VINE_HAND / s;
  ctx.beginPath(); ctx.moveTo(-7, -16); ctx.lineTo(-2, hy - 2); ctx.moveTo(7, -16); ctx.lineTo(2, hy + 3); ctx.stroke();
  ctx.fillStyle = '#ffd9b3';
  ctx.beginPath(); ctx.arc(-2, hy - 2, 2.4, 0, Math.PI * 2); ctx.arc(2, hy + 3, 2.4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ---------- 繪圖：巨蟒 ----------

// 頭的位移：衝撞 / 撕咬時跟著飛行物（嘴 = 飛行物的出發點往前移了多少），預兆時往後縮 / 抬頭，其他時候慢慢回原位
function headOffset(e, view) {
  const lunge = view.projectiles.find(p => p.weapon && (p.weapon.id === 'snakeCharge' || p.weapon.id === 'snakeBite'));
  if (lunge && lunge.x0 !== undefined) {
    e.viewDx = lunge.x - lunge.x0;
    e.viewDy = lunge.y - lunge.y0;
    return;
  }
  const fx = view.snakeFx;
  let tx = 0, ty = Math.sin(view.time * 1.6) * 3;
  if (!e.alive) ty = Math.min(160, e.deathTimer * 120);
  else if (fx && fx.phase === 'cast') {
    const k = clamp(fx.t / CONFIG.TIMING.bossCast, 0, 1);
    if (fx.action === 'charge') { tx = 46 * Math.min(1, k * 2.5); ty = 8 + Math.sin(fx.t * 40) * 2; }
    else if (fx.action === 'bite') { tx = 34 * Math.min(1, k * 2.5); ty = -6; }
    else if (fx.action === 'spray') ty = -34 * Math.min(1, k * 2);
    else if (fx.action === 'quake') ty = k < 0.78 ? -80 * Math.min(1, k * 1.6) : 26;
  }
  // 照經過的時間（view.time，固定步長推進）慢慢回原位，跟畫面更新率無關
  const dt = e.viewT === undefined ? 0 : Math.max(0, view.time - e.viewT);
  e.viewT = view.time;
  const ease = e.alive ? 1 - Math.pow(0.84, dt * FPS) : 1;
  e.viewDx = (e.viewDx ?? 0) + (tx - (e.viewDx ?? 0)) * ease;
  e.viewDy = (e.viewDy ?? 0) + (ty - (e.viewDy ?? 0)) * ease;
}

// 巨蟒：脖子（頭衝出去才看得到）→ 頭（橢圓，跟判定一樣大）、斑紋、嘴、眼睛、蛇信
export function drawSnake(ctx, e, view) {
  headOffset(e, view);
  const fx = view.snakeFx;
  const rx = e.hw, ry = e.h / 2;
  const hx = e.x + e.viewDx, hy = e.cy + e.viewDy;
  const hurt = e.hurtTimer > 0;
  ctx.save();
  // 只畫水面以上：倒下時、大地震擊砸下去時，頭是沉進水裡（不是蓋在水面與下方狀態列上）
  ctx.beginPath(); ctx.rect(0, 0, CONFIG.WORLD_W, CONFIG.WATER_LEVEL + 2); ctx.clip();
  if (!e.alive) {
    ctx.globalAlpha = Math.max(0, 1 - e.deathTimer / 1.6);
    if (ctx.globalAlpha <= 0) { ctx.restore(); return; }
  }
  // 脖子：從畫面右邊外面接到頭的後半段（倒下沉下去的時候不畫）
  const moved = e.alive && (Math.abs(e.viewDx) > 4 || Math.abs(e.viewDy) > 4);
  if (moved) {
    ctx.strokeStyle = SCALE;
    ctx.lineCap = 'round';
    ctx.lineWidth = ry * 1.45;
    ctx.beginPath();
    ctx.moveTo(hx + rx * 0.35, hy);
    ctx.quadraticCurveTo(e.x + rx * 0.2, e.cy + 10, CONFIG.WORLD_W + ry, e.cy + 40);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(47,42,20,0.45)';
    ctx.lineWidth = ry * 0.5;
    ctx.setLineDash([24, 30]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // 頭
  ctx.save();
  ctx.beginPath(); ctx.ellipse(hx, hy, rx, ry, 0, 0, Math.PI * 2); ctx.clip();
  const g = ctx.createLinearGradient(0, hy - ry, 0, hy + ry);
  g.addColorStop(0, hurt ? '#d9f99d' : '#7f9a3a');
  g.addColorStop(0.55, hurt ? '#bef264' : SCALE);
  g.addColorStop(0.62, hurt ? '#fef9c3' : BELLY);
  g.addColorStop(1, hurt ? '#fef3c7' : '#a8985a');
  ctx.fillStyle = g;
  ctx.fillRect(hx - rx, hy - ry, rx * 2, ry * 2);
  // 頭頂的斑紋（蟒蛇的深色塊、亮邊）
  for (const [dx, dy, w, h] of [[-150, -70, 34, 18], [-80, -88, 44, 22], [10, -96, 52, 24], [100, -92, 50, 24], [190, -80, 46, 22], [-30, -50, 40, 18], [70, -56, 46, 20], [160, -44, 40, 18]]) {
    ctx.fillStyle = 'rgba(200,190,120,0.35)';
    ctx.beginPath(); ctx.ellipse(hx + dx, hy + dy, w + 4, h + 4, 0.1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = BLOTCH;
    ctx.beginPath(); ctx.ellipse(hx + dx, hy + dy, w, h, 0.1, 0, Math.PI * 2); ctx.fill();
  }
  // 鱗片的細紋
  ctx.strokeStyle = 'rgba(30,30,10,0.18)';
  ctx.lineWidth = 1;
  for (let sx = hx - rx; sx < hx + rx; sx += 16) {
    ctx.beginPath(); ctx.moveTo(sx, hy - ry); ctx.lineTo(sx + 40, hy + ry * 0.5); ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = SCALE_DARK;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(hx, hy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();

  // 嘴：一條從嘴尖往後的弧線；噴灑 / 撕咬時張開（上下顎分開，露出毒牙）
  const mouthOpen = e.alive && fx && (fx.action === 'spray' || fx.action === 'bite') ? clamp(fx.t * 4, 0, 1) : 0;
  const my = hy + 10;
  const tipX = hx - rx + 6;
  if (mouthOpen > 0.05) {
    const gap = 26 * mouthOpen;
    ctx.fillStyle = '#3b0a1a';
    ctx.beginPath();
    ctx.moveTo(tipX, my - gap * 0.6);
    ctx.quadraticCurveTo(tipX + 90, my - gap * 0.3, tipX + 170, my);
    ctx.quadraticCurveTo(tipX + 90, my + gap, tipX, my + gap * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#f5f5f4';   // 毒牙
    for (const fxx of [tipX + 14, tipX + 34]) {
      ctx.beginPath(); ctx.moveTo(fxx - 4, my - gap * 0.5); ctx.lineTo(fxx + 4, my - gap * 0.5); ctx.lineTo(fxx, my - gap * 0.5 + 12 * mouthOpen); ctx.closePath(); ctx.fill();
    }
  } else {
    ctx.strokeStyle = '#1c1a0c';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(tipX, my); ctx.quadraticCurveTo(tipX + 90, my + 14, tipX + 190, my - 6); ctx.stroke();
  }
  // 鼻孔
  ctx.fillStyle = '#1c1a0c';
  ctx.beginPath(); ctx.ellipse(tipX + 18, hy - 22, 4, 2.5, -0.3, 0, Math.PI * 2); ctx.fill();
  // 眼睛：紅色、直立的瞳孔，看著目標（撕咬 / 現在行動的人 / 最近的玩家）
  const eyeAt = view.match.snake ? view.match.snake.def.eye : { x: e.x - 185, y: e.cy - 60 };
  const ex = hx + eyeAt.x - e.x, ey = hy + eyeAt.y - e.cy;
  ctx.fillStyle = SCALE_DARK;
  ctx.beginPath(); ctx.ellipse(ex + 2, ey - 6, 26, 12, -0.15, Math.PI, 0); ctx.fill();   // 眉骨
  const glow = fx && fx.action === 'bite' && fx.phase === 'cast' ? 0.5 + 0.5 * Math.sin(fx.t * 24) : 0;
  ctx.fillStyle = e.alive ? (glow > 0 ? `rgb(255,${80 + glow * 120},${60 + glow * 60})` : '#dc2626') : '#6b7280';
  ctx.beginPath(); ctx.ellipse(ex, ey, 17, 13, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#1c1a0c';
  ctx.lineWidth = 2;
  ctx.stroke();
  if (e.alive) {
    const lp = lookPoint(e, view);
    let ox = -4, oy = 2;
    if (lp) { const dx = lp.x - ex, dy = lp.y - ey, d = Math.hypot(dx, dy) || 1; ox = dx / d * 6; oy = dy / d * 4; }
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.ellipse(ex + ox, ey + oy, 3, 10, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.arc(ex - 6, ey - 5, 2.5, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.strokeStyle = '#1c1a0c';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(ex - 10, ey - 8); ctx.lineTo(ex + 10, ey + 8); ctx.moveTo(ex + 10, ey - 8); ctx.lineTo(ex - 10, ey + 8); ctx.stroke();
  }
  // 蛇信：平常每隔一陣子吐一下，噴灑 / 撕咬的預兆時一直吐
  const flick = (view.time + e.x * 0.01) % 2.6;
  const out = e.alive && !mouthOpen ? (flick < 0.45 ? Math.sin(flick / 0.45 * Math.PI) : 0) : 0;
  if (out > 0.02) {
    const len = 44 * out;
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tipX + 4, my);
    ctx.lineTo(tipX - len, my + Math.sin(view.time * 30) * 2);
    ctx.lineTo(tipX - len - 10, my - 7);
    ctx.moveTo(tipX - len, my + Math.sin(view.time * 30) * 2);
    ctx.lineTo(tipX - len - 10, my + 7);
    ctx.stroke();
  }
  ctx.restore();
}

function lookPoint(e, view) {
  const match = view.match;
  const fx = view.snakeFx;
  const target = (fx && fx.targetId && match.byId(fx.targetId)) || (view.currentId && match.byId(view.currentId));
  if (target && target.team === 'players' && target.alive) return { x: target.cx, y: target.cy };
  const alive = match.players.filter(p => p.alive);
  if (!alive.length) return null;
  const m = match.snake.def.mouth;
  const near = alive.reduce((a, b) => (Math.hypot(b.cx - m.x, b.cy - m.y) < Math.hypot(a.cx - m.x, a.cy - m.y) ? b : a));
  return { x: near.cx, y: near.cy };
}

// 巨蟒的招式。衝撞 / 撕咬的飛行物不畫（頭本身就跟著衝出去了）。處理了就回傳 true
export function drawSnakeProjectile(ctx, p, view) {
  const w = p.weapon;
  if (w.id === 'snakeCharge' || w.id === 'snakeBite') return true;
  if (w.id === 'snakeVenom') {
    for (let i = 0; i < p.trail.length; i += 2) {   // 一路滴下來的毒液
      const t = p.trail[i], k = i / p.trail.length;
      ctx.fillStyle = `rgba(168,85,247,${k * 0.55})`;
      ctx.beginPath(); ctx.arc(t.x, t.y, 2 + k * 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = 'rgba(134,239,172,0.35)';
    ctx.beginPath(); ctx.arc(p.x, p.y, w.shellRadius + 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#a855f7';
    ctx.beginPath(); ctx.ellipse(p.x, p.y, w.shellRadius, w.shellRadius * 0.85, Math.atan2(p.vy, p.vx), 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e9d5ff';
    ctx.beginPath(); ctx.arc(p.x - 2, p.y - 2, 2, 0, Math.PI * 2); ctx.fill();
    return true;
  }
  if (w.id === 'snakeQuake') {   // 貼著橋面往左跑的震波：一圈圈的衝擊 + 揚起的碎屑
    for (let i = 0; i < p.trail.length; i += 3) {
      const t = p.trail[i], k = i / p.trail.length;
      ctx.strokeStyle = `rgba(253,186,116,${k * 0.6})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(t.x, t.y + 4, 10 + (1 - k) * 18, 6 + (1 - k) * 8, 0, Math.PI, 0); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(254,215,170,0.85)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, 16, 10, 0, Math.PI, 0); ctx.fill();
    const tick = Math.floor(view.time * 36);   // 每秒 36 顆碎屑（照時間，不照畫面更新次數）
    if (tick !== p.debrisTick) {
      p.debrisTick = tick;
      view.particles.push({ x: p.x, y: p.y, vx: (Math.random() - 0.2) * 120, vy: -120 - Math.random() * 160, life: 0.5, maxLife: 0.5, size: 3, color: Math.random() < 0.5 ? '#65a30d' : '#a16207', gravity: 600 });
    }
    return true;
  }
  return false;
}

// ---------- 背景 ----------

// 叢林背景：深綠的樹海、垂下來的藤影、水面上的霧
export function buildJungleBackground(W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#071a12');
  sky.addColorStop(0.45, '#123826');
  sky.addColorStop(0.8, '#2f5a36');
  sky.addColorStop(1, '#4f7a46');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // 遠方的樹幹（兩層）與垂下來的藤影
  const layers = [
    { trunk: 'rgba(12,36,22,0.55)', leaf: 'rgba(20,56,32,0.55)', seed: 5 },
    { trunk: 'rgba(6,24,14,0.8)', leaf: 'rgba(10,38,22,0.75)', seed: 11 },
  ];
  for (const L of layers) {
    for (let x = -10; x < W; x += 90 + ((x * L.seed) % 50)) {
      const w = 14 + ((x * L.seed) % 18);
      ctx.fillStyle = L.trunk;
      ctx.fillRect(x - w / 2, 0, w, H);
      ctx.strokeStyle = L.leaf;
      ctx.lineWidth = 2;
      for (let k = 0; k < 2; k++) {
        const vx = x + 20 + k * 26, len = 160 + ((x + k * 37) % 220);
        ctx.beginPath(); ctx.moveTo(vx, 0); ctx.quadraticCurveTo(vx + 12, len / 2, vx - 4, len); ctx.stroke();
      }
    }
  }
  // 大片的葉子剪影（畫面兩側）
  ctx.fillStyle = 'rgba(8,30,16,0.85)';
  for (const [x, y, r, a] of [[30, 300, 90, 0.6], [-10, 470, 110, -0.3], [990, 260, 80, 2.4], [1020, 420, 100, 3.3], [520, 40, 70, 1.4]]) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(-r, 0); ctx.quadraticCurveTo(0, -r * 0.45, r, 0); ctx.quadraticCurveTo(0, r * 0.45, -r, 0); ctx.fill();
    ctx.restore();
  }
  // 水面上的霧
  const mist = ctx.createLinearGradient(0, 520, 0, 660);
  mist.addColorStop(0, 'rgba(200,230,200,0)');
  mist.addColorStop(1, 'rgba(200,230,200,0.22)');
  ctx.fillStyle = mist;
  ctx.fillRect(0, 520, W, 140);
  // 螢火蟲
  for (let i = 0; i < 36; i++) {
    const x = (i * 211) % W, y = 120 + (i * 149) % (H - 300);
    ctx.fillStyle = `rgba(217,249,157,${0.12 + (i % 5) * 0.07})`;
    ctx.beginPath(); ctx.arc(x, y, 1.4 + (i % 3), 0, Math.PI * 2); ctx.fill();
  }
  return c;
}
