import { CONFIG } from '../../shared/config.js';
import { SNAKE_ACTION_NAMES, chargeLane, takeDrops, pickupAlong } from '../../shared/snake-boss.js';
import { clamp } from '../../shared/utils.js';

// 叢林巨蟒的地圖畫面：巨蟒回合的動畫腳本（照伺服器廣播的招式播）、巨蟒倒下的特效、蛇血（掉出來、喝到、自己走過去先喝），
// 與巨蟒 / 藤蔓 / 蛇血 / 招式的繪圖。掛勾的說明見 index.js
const FPS = 60;
const SCALE = '#5f7a2c', SCALE_DARK = '#3b4a1a', BELLY = '#c8b878', BLOTCH = '#2f2a14';
const POISON = '#c084fc';
const DROP_FLIGHT = 0.7;   // 掉出來的蛇血飛到落點要幾秒

export const snake = {
  type: 'snake',

  // 這一場的畫面狀態：
  //   fx     巨蟒出招的預兆動畫 { action, t, phase: 'cast' | 'act', targetId }（巨蟒回合播完就清掉）
  //   head   頭畫面上的位移（id → { dx, dy, t }：衝出去 / 縮回來 / 抬頭，照 c.time 慢慢回原位）
  //   anims  剛掉出來、還在飛的蛇血（道具 id → { x, y, t0 }：從嘴裡沿拋物線飛到落點，飛完由 update 刪掉）。
  //          照 id 對：GameView 換成伺服器版本的道具（setItems）也接得上；道具的 id 不會重複用
  create: () => ({ fx: null, head: new Map(), anims: new Map() }),

  musicTrack: () => 'snake',   // 先一聲蛇的哈氣再淡入（見 music.js）
  turnScript: snakeTurnScript,
  abortScript(c) { c.state.fx = null; },   // 播到一半丟掉：預兆（縮頭、抬頭、張嘴、眼睛發光）不要一直留著
  onDeath: onSnakeDeath,

  // 每一步：飛完的蛇血刪掉記錄；大地震擊的震波一路揚起碎屑（畫圖只讀狀態，不在畫圖時做這些）
  update(c) {
    for (const [id, a] of c.state.anims) if (dropProgress(c, a) >= 1) c.state.anims.delete(id);
    for (const p of c.projectiles) if (p.weapon && p.weapon.id === 'snakeQuake') quakeDebris(c, p);
  },

  // 打到巨蟒跨過門檻：掉蛇血
  showEvent(c, ev, made) {
    if (ev.drops) showDrops(c, ev.drops, made.items);
  },

  // 巨蟒被燒到跨過門檻，掉出蛇血
  turnFx(c, e, fx) {
    if (fx.type !== 'drops') return false;
    addDrops(c, fx.items);
    return true;
  },

  statusFx,

  // 行動玩家走路途中喝到蛇血（伺服器廣播的 pickup）：改上限與血量（位置照他自己 / 他的 move 回報）。
  // 自己的血量照本地的（喝完之後可能已經在本地掉過水），伺服器帶的 hp 是喝的那一刻：自己已經先喝過（預測）就什麼都不用改，
  // 沒預測到（伺服器的直線判到、自己的路線沒碰到）才在本地補上回的血
  onPickup(c, e, msg, self) {
    const predicted = self && !c.match.mechState.items.some(it => it.id === msg.item);
    e.maxHp = msg.mhp;
    e.poisonLock = msg.lk;
    e.poison = 0;   // 喝了蛇血就解毒
    if (!self) e.hp = msg.hp;
    else if (!predicted) e.hp = Math.min(e.maxHp, e.hp + (msg.heal || 0));
    if (!predicted) statusFx(c, e, msg);
  },

  // 自己的回合這一幀從 (px, py) 走到現在的位置，路上碰到蛇血（有被鎖住的上限或血沒滿）就先在本地喝掉（跟伺服器同一套判斷）；
  // 回傳 true = 喝到了，GameView 馬上回報位置：伺服器檢查的線段就停在蛇血上，一定也會判到（之後的 pickup 只是確認）
  predictMove(c, me, px, py) {
    const got = pickupAlong(c.match, me, px, py, me.x, me.y);
    if (!got) return false;
    statusFx(c, me, got);
    return true;
  },

  drawScene: drawSnakeScene,

  // 巨蟒的頭先畫：被大地震擊甩到嘴前的人要畫在牠前面，不會像是鑽進牠的頭裡
  drawEntityFirst: (c, e) => e.part === 'snake',

  // 巨蟒沉進水裡（自己淡出、沒有血條）
  drawEntityBare(ctx, c, e) {
    if (e.part !== 'snake' || e.alive) return false;
    drawSnake(ctx, c, e);
    return true;
  },

  // 叢林巨蟒的頭
  drawEntity(ctx, c, e) {
    if (e.part !== 'snake') return false;
    drawSnake(ctx, c, e);
    return 'body';
  },

  // 巨蟒的血條比較長，每 bloodEveryPct%（掉蛇血的門檻）一道刻度
  hpBar: (c, e) => (e.part === 'snake' ? { w: 170, h: 8, ticks: CONFIG.SNAKE_BOSS.bloodEveryPct } : null),

  drawProjectile: drawSnakeProjectile,

  // 隊伍名單下面：巨蟒的血量
  hud(c) {
    const s = c.match.byId('snake');
    return [[`叢林巨蟒 ${s.hp} / ${s.maxHp}`, '#fca5a5']];
  },
};

// ---------- 動畫腳本 ----------

// 巨蟒的回合：預兆（衝撞：往後縮、警示帶快閃；噴灑：抬頭張嘴；震擊：抬頭再砸進水裡；撕咬：往後縮、眼睛發光）
// → 出招（照 shotScript 重播；衝撞 / 撕咬時頭跟著飛行物衝出去）→ 校正成伺服器結果。
// c.state.fx 給畫面用：{ action, t, phase: 'cast' | 'act', targetId }。
// 全部播完才換上伺服器預定的下一招（msg.boss.next）：衝撞的警示帶留到真的撞下去，新的在巨蟒回合之後才出現
function* snakeTurnScript(c, msg) {
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* snakeStepScript(c, step);
  c.state.fx = null;
  if (c.match.mechState && msg.boss.next !== undefined) c.match.mechState.next = msg.boss.next;
}

function* snakeStepScript(c, b) {
  const match = c.match;
  const def = match.mechState ? match.mechState.def : null;
  const fx = c.state.fx = { action: b.action, t: 0, phase: 'cast', targetId: b.targetId ?? null };
  const cast = Math.round(CONFIG.TIMING.bossCast * FPS);
  const name = SNAKE_ACTION_NAMES[b.action] || '';
  const target = b.targetId ? match.byId(b.targetId) : null;
  if (b.action === 'idle') c.fx.banner(SNAKE_ACTION_NAMES.idle, '#d9f99d');
  else c.fx.banner(`巨蟒：${name}${target ? ` → ${target.name}` : ''}！`, b.action === 'charge' ? '#fca5a5' : b.action === 'quake' ? '#fdba74' : POISON);
  const slam = Math.round(cast * 0.78);
  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    if (b.action === 'charge' && i % 8 === 0) c.fx.shake(2);
    if (b.action === 'spray' && def && i % 3 === 0) {   // 毒液在嘴邊聚起來
      const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 25;
      const o = def.mouth;
      c.fx.particle({ x: o.x + Math.cos(a) * r, y: o.y + Math.sin(a) * r, vx: -Math.cos(a) * r * 2.2, vy: -Math.sin(a) * r * 2.2, life: 0.4, maxLife: 0.4, size: 3, color: Math.random() < 0.5 ? '#a855f7' : '#86efac', gravity: 0 });
    }
    if (b.action === 'quake' && i === slam) {   // 頭砸進水裡：大水花、整個畫面震
      c.fx.shake(16);
      for (let x = 620; x <= 1000; x += 60) c.fx.splash(x);
      if (def) c.fx.particles(def.bridge.x1 - 10, def.bridge.y, 16, { speed: 160, life: 0.6, size: 3, color: '#4d7c0f', gravity: 500 });
    }
    yield { frames: 1 };
  }
  fx.phase = 'act';
  if (b.action === 'quake') c.fx.shake(10);
  if (b.shot) {
    yield* c.shotScript(b.shot);
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }
}

// 巨蟒倒下：回傳 true 表示處理過了（不要再顯示一般的「被擊倒」橫幅）
function onSnakeDeath(c, e) {
  if (e.part !== 'snake') return false;
  c.fx.banner('叢林巨蟒倒下了！', '#fde047');
  c.fx.shake(14);
  c.fx.particles(e.x - e.hw * 0.6, e.cy, 40, { speed: 240, life: 1.2, size: 4, color: '#65a30d', gravity: 250 });
  for (let x = 620; x <= 1000; x += 50) c.fx.splash(x);
  return true;
}

// 蛇血從巨蟒嘴裡掉出來（回合結束效果帶來的 drops）：加進場上（已經有的跳過），再播出來
function addDrops(c, drops) {
  if (!c.match || !drops) return;
  showDrops(c, drops, takeDrops(c.match, drops));
}

// 掉出來的蛇血的畫面：items = 這次新加進場上的（重播時由 shared/volley.js 加），用 0.7 秒的拋物線飛到落點；
// 好幾瓶時照 drops 裡的順序一瓶一瓶飛出來
function showDrops(c, drops, items) {
  const match = c.match;
  const from = match.mechState ? match.mechState.def.mouth : { x: 600, y: 500 };
  for (const it of items) {
    const k = Math.max(0, drops.findIndex(d => d.id === it.id));
    c.state.anims.set(it.id, { x: from.x, y: from.y - 20, t0: c.time + k * 0.12 });
  }
  c.fx.float(match.byId('snake') || { cx: from.x, y: from.y, h: 0, id: 'snake' }, drops.length > 1 ? `掉出蛇血 ×${drops.length}` : '掉出蛇血', '#f87171', 16);
}

// 喝到蛇血的飄字與特效（回合開始的 fx、回合沒開始的 turnFx、走路喝到的 pickup、自己先喝的預測都用這個）：蛇血從場上拿掉
function statusFx(c, e, fx) {
  if (fx.type !== 'snakeBlood') return;
  c.match.mechState.items = c.match.mechState.items.filter(it => it.id !== fx.item);
  c.state.anims.delete(fx.item);   // 還沒飛完的拋物線跟著蛇血一起不見
  c.fx.float(e, fx.heal > 0 ? `蛇血！+${fx.heal}` : '蛇血！', '#f87171');
  if (fx.cured > 0) c.fx.float(e, '解毒', '#e9d5ff', 15);
  if (fx.unlocked > 0) c.fx.float(e, `上限 +${fx.unlocked}`, '#fca5a5', 15);
  c.fx.particles(e.cx, e.cy, 18, { speed: 120, life: 0.8, size: 3, color: '#ef4444', gravity: -60 });
}

// ---------- 繪圖：場景 ----------

// 藤蔓、水裡的蛇身、蛇血、預定衝撞的警示帶（地形之後、角色之前畫）。
// 藤蔓是地形（不分地圖），但目前只有這張地圖有，所以畫在這裡
function drawSnakeScene(ctx, c) {
  const match = c.match;
  if (!match || !match.mechState) return;
  drawCoils(ctx, c);
  drawCanopy(ctx);
  match.terrain.vines.forEach((v, i) => drawVine(ctx, v, i, c.time));
  for (const it of match.mechState.items) drawItem(ctx, c, it);

  const snake = match.byId('snake');
  const next = match.mechState.next;
  const fx = c.state.fx;
  if (!snake || !snake.alive) return;
  // 預定的巨蟒衝撞：玩家回合一直標著範圍（慢慢呼吸），巨蟒出招前快閃；真的衝出去之後就不畫了（頭本身就是範圍）
  if (fx && fx.action === 'charge') {
    if (fx.phase === 'cast') drawChargeBand(ctx, match, 0.22 + 0.14 * Math.sin(fx.t * 16), 1, c.time);
  } else if (next && next.action === 'charge') {
    drawChargeBand(ctx, match, 0.16 + 0.06 * Math.sin(c.time * 3), 0.9, c.time);
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
function drawCoils(ctx, c) {
  const snake = c.match.byId('snake');
  const sink = snake && !snake.alive ? Math.min(60, snake.deathTimer * 40) : 0;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, CONFIG.WORLD_W, CONFIG.WATER_LEVEL + 2); ctx.clip();
  for (const [x, r, ph] of [[700, 46, 0], [835, 58, 1.3], [985, 64, 2.4]]) {
    const y = CONFIG.WATER_LEVEL + 22 + Math.sin(c.time * 1.4 + ph) * 3 + sink;
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

// 剛掉出來的蛇血飛到哪了：0 以下 = 還沒輪到它飛出來、1 以上 = 飛完了（照 c.time 算，跟畫面更新率無關）
const dropProgress = (c, anim) => (c.time - anim.t0) / DROP_FLIGHT;

// 蛇血瓶：玻璃瓶 + 發亮的紅色蛇血 + 軟木塞，輕輕上下浮動。剛掉出來的沿拋物線飛過去（c.state.anims；飛完的記錄由 update 刪，畫圖不改狀態）
function drawItem(ctx, c, it) {
  let x = it.x, y = it.y;
  const anim = c.state.anims.get(it.id);
  const t = anim ? dropProgress(c, anim) : 1;
  if (t <= 0) return;
  const flying = t < 1;
  if (flying) {
    x = anim.x + (it.x - anim.x) * t;
    y = anim.y + (it.y - anim.y) * t - Math.sin(t * Math.PI) * 110;
  }
  drawSnakeBlood(ctx, x, y - 2 + (flying ? 0 : Math.sin(c.time * 3 + it.x) * 1.5), c.time);
}

function drawSnakeBlood(ctx, x, y, time) {
  const glow = 0.35 + 0.25 * Math.sin(time * 4 + x);
  ctx.save();
  ctx.fillStyle = `rgba(239,68,68,${glow * 0.5})`;
  ctx.beginPath(); ctx.arc(x, y - 9, 13, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(254,226,226,0.35)';   // 瓶身
  ctx.strokeStyle = 'rgba(254,242,242,0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x, y - 7, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#dc2626';                   // 蛇血
  ctx.beginPath(); ctx.arc(x, y - 7, 5.5, 0.15 * Math.PI, 0.85 * Math.PI); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y - 7, 5.5, 0, Math.PI); ctx.fill();
  ctx.fillStyle = 'rgba(254,226,226,0.5)';     // 瓶頸
  ctx.fillRect(x - 2.5, y - 18, 5, 5);
  ctx.strokeRect(x - 2.5, y - 18, 5, 5);
  ctx.fillStyle = '#a16207';                   // 軟木塞
  ctx.fillRect(x - 3, y - 21, 6, 4);
  ctx.fillStyle = '#fff';                      // 反光
  ctx.beginPath(); ctx.arc(x - 2.5, y - 9.5, 1.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ---------- 繪圖：巨蟒 ----------

// 頭的位移：衝撞 / 撕咬時跟著飛行物（嘴 = 飛行物的出發點往前移了多少），預兆時往後縮 / 抬頭，其他時候慢慢回原位。回傳 { dx, dy }
function headOffset(c, e) {
  let h = c.state.head.get(e.id);
  if (!h) c.state.head.set(e.id, h = {});
  const lunge = c.projectiles.find(p => p.weapon && (p.weapon.id === 'snakeCharge' || p.weapon.id === 'snakeBite'));
  if (lunge && lunge.x0 !== undefined) {
    h.dx = lunge.x - lunge.x0;
    h.dy = lunge.y - lunge.y0;
    h.t = c.time;   // 計時也要跟著走：飛行物一消失，下面才是從這一刻慢慢縮回原位（不然整段衝刺都算進去，一幀就彈回去）
    return h;
  }
  const fx = c.state.fx;
  let tx = 0, ty = Math.sin(c.time * 1.6) * 3;
  if (!e.alive) ty = Math.min(160, e.deathTimer * 120);
  else if (fx && fx.phase === 'cast') {
    const k = clamp(fx.t / CONFIG.TIMING.bossCast, 0, 1);
    if (fx.action === 'charge') { tx = 46 * Math.min(1, k * 2.5); ty = 8 + Math.sin(fx.t * 40) * 2; }
    else if (fx.action === 'bite') { tx = 34 * Math.min(1, k * 2.5); ty = -6; }
    else if (fx.action === 'spray') ty = -34 * Math.min(1, k * 2);
    else if (fx.action === 'quake') ty = k < 0.78 ? -80 * Math.min(1, k * 1.6) : 26;
  }
  // 照經過的時間（c.time，固定步長推進）慢慢回原位，跟畫面更新率無關
  const dt = h.t === undefined ? 0 : Math.max(0, c.time - h.t);
  h.t = c.time;
  const ease = e.alive ? 1 - Math.pow(0.84, dt * FPS) : 1;
  h.dx = (h.dx ?? 0) + (tx - (h.dx ?? 0)) * ease;
  h.dy = (h.dy ?? 0) + (ty - (h.dy ?? 0)) * ease;
  return h;
}

// 巨蟒：脖子（頭衝出去才看得到）→ 頭（橢圓，跟判定一樣大）、斑紋、嘴、眼睛、蛇信
function drawSnake(ctx, c, e) {
  const head = headOffset(c, e);
  const fx = c.state.fx;
  const rx = e.hw, ry = e.h / 2;
  const hx = e.x + head.dx, hy = e.cy + head.dy;
  const hurt = e.hurtTimer > 0;
  ctx.save();
  // 只畫水面以上：倒下時、大地震擊砸下去時，頭是沉進水裡（不是蓋在水面與下方狀態列上）
  ctx.beginPath(); ctx.rect(0, 0, CONFIG.WORLD_W, CONFIG.WATER_LEVEL + 2); ctx.clip();
  if (!e.alive) {
    ctx.globalAlpha = Math.max(0, 1 - e.deathTimer / 1.6);
    if (ctx.globalAlpha <= 0) { ctx.restore(); return; }
  }
  // 脖子：從畫面右邊外面接到頭的後半段（倒下沉下去的時候不畫）
  const moved = e.alive && (Math.abs(head.dx) > 4 || Math.abs(head.dy) > 4);
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
  const eyeAt = c.match.mechState ? c.match.mechState.def.eye : { x: e.x - 185, y: e.cy - 60 };
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
    const lp = lookPoint(c);
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
  const flick = (c.time + e.x * 0.01) % 2.6;
  const out = e.alive && !mouthOpen ? (flick < 0.45 ? Math.sin(flick / 0.45 * Math.PI) : 0) : 0;
  if (out > 0.02) {
    const len = 44 * out;
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tipX + 4, my);
    ctx.lineTo(tipX - len, my + Math.sin(c.time * 30) * 2);
    ctx.lineTo(tipX - len - 10, my - 7);
    ctx.moveTo(tipX - len, my + Math.sin(c.time * 30) * 2);
    ctx.lineTo(tipX - len - 10, my + 7);
    ctx.stroke();
  }
  ctx.restore();
}

function lookPoint(c) {
  const match = c.match;
  const fx = c.state.fx;
  const target = (fx && fx.targetId && match.byId(fx.targetId)) || (c.currentId && match.byId(c.currentId));
  if (target && target.team === 'players' && target.alive) return { x: target.cx, y: target.cy };
  const alive = match.players.filter(p => p.alive);
  if (!alive.length) return null;
  const m = match.mechState.def.mouth;
  const near = alive.reduce((a, b) => (Math.hypot(b.cx - m.x, b.cy - m.y) < Math.hypot(a.cx - m.x, a.cy - m.y) ? b : a));
  return { x: near.cx, y: near.cy };
}

// 巨蟒的招式。衝撞 / 撕咬的飛行物不畫（頭本身就跟著衝出去了）。處理了就回傳 true
function drawSnakeProjectile(ctx, c, p) {
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
    return true;   // 揚起的碎屑由 update 每一步放（quakeDebris）
  }
  return false;
}

// 大地震擊的震波揚起的碎屑：每秒 36 顆（照遊戲時間，不照畫面更新次數；update 每一步呼叫，背景分頁沒畫面也一樣）
function quakeDebris(c, p) {
  const tick = Math.floor(c.time * 36);
  if (tick === p.debrisTick) return;
  p.debrisTick = tick;
  c.fx.particle({ x: p.x, y: p.y, vx: (Math.random() - 0.2) * 120, vy: -120 - Math.random() * 160, life: 0.5, maxLife: 0.5, size: 3, color: Math.random() < 0.5 ? '#65a30d' : '#a16207', gravity: 600 });
}
